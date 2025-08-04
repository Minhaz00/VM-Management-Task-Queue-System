import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { v4 as uuidv4 } from 'uuid';

type Bindings = {
  TASK_STORAGE: KVNamespace;
  VM_TASK_QUEUE: Queue;
};

interface VMTask {
  id: string;
  type: 'launch_vm' | 'delete_vm';
  payload: {
    vmName: string;
    vmConfig?: {
      memory?: string;
      vcpus?: number;
      diskSize?: string;
      imageUrl?: string;
    };
    targetServer?: string; // Optional server identifier, not URL
  };
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  result?: any;
}

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'vm-api-worker'
  });
});

// Create a new VM task (launch or delete)
app.post('/vm/tasks', async (c) => {
  try {
    const body = await c.req.json();
    const { type, payload } = body;

    // Validate required fields
    if (!type || !payload || !payload.vmName) {
      return c.json({
        success: false,
        error: 'Missing required fields: type, payload.vmName'
      }, 400);
    }

    // Validate task type
    if (!['launch_vm', 'delete_vm'].includes(type)) {
      return c.json({
        success: false,
        error: 'Invalid task type. Must be "launch_vm" or "delete_vm"'
      }, 400);
    }

    const taskId = uuidv4();
    const now = new Date().toISOString();

    const task: VMTask = {
      id: taskId,
      type,
      payload: {
        vmName: payload.vmName,
        vmConfig: payload.vmConfig || {},
        targetServer: payload.targetServer || 'default'
      },
      status: 'pending',
      createdAt: now,
      updatedAt: now
    };

    // Store task in KV
    await c.env.TASK_STORAGE.put(`task:${taskId}`, JSON.stringify(task));
    
    // Add task to processing queue
    await c.env.VM_TASK_QUEUE.send({
      taskId,
      type,
      payload: task.payload,
      timestamp: now
    });

    console.log(`VM task created: ${taskId} (${type}) for VM: ${payload.vmName}`);

    return c.json({
      success: true,
      taskId,
      status: 'pending',
      message: `VM ${type.replace('_', ' ')} task queued successfully`
    });

  } catch (error) {
    console.error('Error creating VM task:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Get task status
app.get('/vm/tasks/:taskId/status', async (c) => {
  try {
    const taskId = c.req.param('taskId');
    const taskJson = await c.env.TASK_STORAGE.get(`task:${taskId}`);
    
    if (!taskJson) {
      return c.json({
        success: false,
        error: 'Task not found'
      }, 404);
    }

    const task: VMTask = JSON.parse(taskJson);
    
    return c.json({
      taskId: task.id,
      type: task.type,
      status: task.status,
      vmName: task.payload.vmName,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      error: task.error,
      result: task.result
    });

  } catch (error) {
    console.error('Error getting task status:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// List all tasks
app.get('/vm/tasks', async (c) => {
  try {
    const { keys } = await c.env.TASK_STORAGE.list({ prefix: 'task:' });
    const tasks = [];

    for (const key of keys) {
      const taskJson = await c.env.TASK_STORAGE.get(key.name);
      if (taskJson) {
        const task: VMTask = JSON.parse(taskJson);
        tasks.push({
          id: task.id,
          type: task.type,
          status: task.status,
          vmName: task.payload.vmName,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          completedAt: task.completedAt
        });
      }
    }

    // Sort by creation date (newest first)
    tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({
      tasks,
      count: tasks.length
    });

  } catch (error) {
    console.error('Error listing tasks:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Update task status (called by consumer/local consumer)
app.put('/vm/tasks/:taskId/status', async (c) => {
  try {
    const taskId = c.req.param('taskId');
    const body = await c.req.json();
    const { status, error, result } = body;

    const taskJson = await c.env.TASK_STORAGE.get(`task:${taskId}`);
    if (!taskJson) {
      return c.json({
        success: false,
        error: 'Task not found'
      }, 404);
    }

    const task: VMTask = JSON.parse(taskJson);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    
    if (status === 'completed' || status === 'failed') {
      task.completedAt = new Date().toISOString();
    }
    
    if (error) {
      task.error = error;
    }
    
    if (result) {
      task.result = result;
    }

    await c.env.TASK_STORAGE.put(`task:${taskId}`, JSON.stringify(task));

    console.log(`Task ${taskId} status updated to: ${status}`);

    return c.json({
      success: true,
      message: `Task marked as ${status}`,
      taskId,
      status
    });

  } catch (error) {
    console.error('Error updating task status:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Cancel a pending task
app.delete('/vm/tasks/:taskId', async (c) => {
  try {
    const taskId = c.req.param('taskId');
    const taskJson = await c.env.TASK_STORAGE.get(`task:${taskId}`);
    
    if (!taskJson) {
      return c.json({
        success: false,
        error: 'Task not found'
      }, 404);
    }

    const task: VMTask = JSON.parse(taskJson);
    
    if (task.status !== 'pending') {
      return c.json({
        success: false,
        error: `Cannot cancel task with status: ${task.status}`
      }, 400);
    }

    // Mark as cancelled (using failed status with specific error)
    task.status = 'failed';
    task.error = 'Task cancelled by user';
    task.updatedAt = new Date().toISOString();
    task.completedAt = new Date().toISOString();

    await c.env.TASK_STORAGE.put(`task:${taskId}`, JSON.stringify(task));

    return c.json({
      success: true,
      message: 'Task cancelled successfully',
      taskId
    });

  } catch (error) {
    console.error('Error cancelling task:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Get VM status from Arrakis (proxy endpoint)
app.get('/vm/:vmName/status', async (c) => {
  try {
    const vmName = c.req.param('vmName');
    // const arrakisUrl = c.req.query('arrakis_url') || 'http://127.0.0.1:7000';
    
    // This would typically call the actual Arrakis API
    // For now, return a placeholder response
    return c.json({
      vmName,
      status: 'unknown',
      message: 'Direct VM status check - implement Arrakis API integration'
    });

  } catch (error) {
    console.error('Error getting VM status:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Default route
app.get('/', (c) => {
  return c.json({
    service: 'VM Management API Worker',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      createTask: 'POST /vm/tasks',
      getTaskStatus: 'GET /vm/tasks/:taskId/status',
      listTasks: 'GET /vm/tasks',
      updateTaskStatus: 'PUT /vm/tasks/:taskId/status',
      cancelTask: 'DELETE /vm/tasks/:taskId',
      getVMStatus: 'GET /vm/:vmName/status'
    }
  });
});

export default app;