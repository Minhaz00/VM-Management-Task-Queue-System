import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  TASK_BUFFER: KVNamespace;
  VM_TASK_QUEUE: Queue;
};

interface QueueMessage {
  taskId: string;
  type: 'launch_vm' | 'delete_vm';
  payload: {
    vmName: string;
    vmConfig?: any;
    arrakisConfig?: any;
  };
  timestamp: string;
}

interface TaskBuffer {
  id: string;
  type: string;
  payload: any;
  createdAt: string;
  receivedAt: string;
  claimedAt?: string;
  claimedBy?: string;
  status: 'ready' | 'claimed' | 'processing';
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
    service: 'vm-consumer-worker'
  });
});

// Queue consumer handler
async function handleQueueMessage(batch: MessageBatch<QueueMessage>, env: Bindings) {
  console.log(`Processing batch of ${batch.messages.length} VM task messages`);

  for (const message of batch.messages) {
    try {
      const { taskId, type, payload, timestamp } = message.body;
      
      console.log(`Processing VM task: ${taskId} (${type}) for VM: ${payload.vmName}`);

      // Create task buffer entry for local consumer
      const taskBuffer: TaskBuffer = {
        id: taskId,
        type,
        payload,
        createdAt: timestamp,
        receivedAt: new Date().toISOString(),
        status: 'ready'
      };

      // Store in task buffer (KV store for local consumer to poll)
      await env.TASK_BUFFER.put(`buffer:${taskId}`, JSON.stringify(taskBuffer), {
        // Tasks expire after 1 hour if not claimed
        expirationTtl: 3600
      });

      console.log(`Task ${taskId} added to buffer for local consumer processing`);

      // Acknowledge message
      message.ack();

    } catch (error) {
      console.error(`Error processing message ${message.id}:`, error);
      
      // Retry the message
      message.retry({
        delaySeconds: 30 // Retry after 30 seconds
      });
    }
  }
}

// Get ready tasks for local consumer polling
app.get('/tasks/ready', async (c) => {
  try {
    const { keys } = await c.env.TASK_BUFFER.list({ prefix: 'buffer:' });
    const readyTasks = [];

    for (const key of keys) {
      const taskJson = await c.env.TASK_BUFFER.get(key.name);
      if (taskJson) {
        const task: TaskBuffer = JSON.parse(taskJson);
        if (task.status === 'ready') {
          readyTasks.push({
            id: task.id,
            type: task.type,
            vmName: task.payload.vmName,
            createdAt: task.createdAt,
            receivedAt: task.receivedAt
          });
        }
      }
    }

    // Sort by creation time (oldest first)
    readyTasks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    console.log(`Found ${readyTasks.length} ready VM tasks`);

    return c.json({
      tasks: readyTasks,
      count: readyTasks.length
    });

  } catch (error) {
    console.error('Error getting ready tasks:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Claim a task for processing
app.post('/tasks/:taskId/claim', async (c) => {
  try {
    const taskId = c.req.param('taskId');
    const body = await c.req.json();
    const { consumerId } = body;

    if (!consumerId) {
      return c.json({
        success: false,
        error: 'Consumer ID is required'
      }, 400);
    }

    const taskJson = await c.env.TASK_BUFFER.get(`buffer:${taskId}`);
    if (!taskJson) {
      return c.json({
        success: false,
        error: 'Task not found'
      }, 404);
    }

    const task: TaskBuffer = JSON.parse(taskJson);

    if (task.status !== 'ready') {
      return c.json({
        success: false,
        error: `Task is not ready for claiming (status: ${task.status})`
      }, 409);
    }

    // Claim the task
    task.status = 'claimed';
    task.claimedAt = new Date().toISOString();
    task.claimedBy = consumerId;

    await c.env.TASK_BUFFER.put(`buffer:${taskId}`, JSON.stringify(task));

    console.log(`Task ${taskId} claimed by consumer ${consumerId}`);

    return c.json({
      success: true,
      message: 'Task claimed successfully',
      task: {
        id: task.id,
        type: task.type,
        payload: task.payload,
        createdAt: task.createdAt,
        receivedAt: task.receivedAt,
        claimedAt: task.claimedAt
      }
    });

  } catch (error) {
    console.error('Error claiming task:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Get all tasks in buffer (for debugging)
app.get('/tasks/all', async (c) => {
  try {
    const { keys } = await c.env.TASK_BUFFER.list({ prefix: 'buffer:' });
    const allTasks = [];

    for (const key of keys) {
      const taskJson = await c.env.TASK_BUFFER.get(key.name);
      if (taskJson) {
        const task: TaskBuffer = JSON.parse(taskJson);
        allTasks.push(task);
      }
    }

    // Sort by creation time
    allTasks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return c.json({
      tasks: allTasks,
      count: allTasks.length
    });

  } catch (error) {
    console.error('Error getting all tasks:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Remove completed task from buffer
app.delete('/tasks/:taskId', async (c) => {
  try {
    const taskId = c.req.param('taskId');
    
    await c.env.TASK_BUFFER.delete(`buffer:${taskId}`);
    
    console.log(`Task ${taskId} removed from buffer`);

    return c.json({
      success: true,
      message: 'Task removed from buffer'
    });

  } catch (error) {
    console.error('Error removing task from buffer:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Get buffer statistics
app.get('/stats', async (c) => {
  try {
    const { keys } = await c.env.TASK_BUFFER.list({ prefix: 'buffer:' });
    const stats = {
      ready: 0,
      claimed: 0,
      processing: 0,
      total: 0
    };

    for (const key of keys) {
      const taskJson = await c.env.TASK_BUFFER.get(key.name);
      if (taskJson) {
        const task: TaskBuffer = JSON.parse(taskJson);
        stats[task.status]++;
        stats.total++;
      }
    }

    return c.json({
      buffer: stats,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error getting buffer stats:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Default route
app.get('/', (c) => {
  return c.json({
    service: 'VM Task Consumer Worker',
    version: '1.0.0',
    description: 'Processes VM tasks from queue and buffers them for local consumers',
    endpoints: {
      health: 'GET /health',
      readyTasks: 'GET /tasks/ready',
      claimTask: 'POST /tasks/:taskId/claim',
      allTasks: 'GET /tasks/all',
      removeTask: 'DELETE /tasks/:taskId',
      stats: 'GET /stats'
    }
  });
});

// Export queue handler and default app
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage>, env: Bindings): Promise<void> {
    await handleQueueMessage(batch, env);
  }
};
