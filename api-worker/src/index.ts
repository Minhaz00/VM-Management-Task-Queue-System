import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { v4 as uuidv4 } from 'uuid';

type Bindings = {
  DB: D1Database;
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
    targetServer?: string;
  };
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  result?: any;
}

interface VM {
  id: string;
  name: string;
  ipAddress?: string;
  status: string;
  subdomain?: string;
  port: number;
  createdAt: string;
  updatedAt: string;
  metadata?: any;
}

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Database helper functions
async function createTask(db: D1Database, task: VMTask): Promise<void> {
  await db.prepare(`
    INSERT INTO vm_tasks (
      id, type, vm_name, vm_config, target_server, status, 
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  .bind(
    task.id,
    task.type,
    task.payload.vmName,
    JSON.stringify(task.payload.vmConfig || {}),
    task.payload.targetServer || 'default',
    task.status,
    task.createdAt,
    task.updatedAt
  )
  .run();
}

async function getTask(db: D1Database, taskId: string): Promise<VMTask | null> {
  const result = await db.prepare(`
    SELECT * FROM vm_tasks WHERE id = ?
  `).bind(taskId).first();

  if (!result) return null;

  return {
    id: result.id as string,
    type: result.type as 'launch_vm' | 'delete_vm',
    payload: {
      vmName: result.vm_name as string,
      vmConfig: result.vm_config ? JSON.parse(result.vm_config as string) : {},
      targetServer: result.target_server as string
    },
    status: result.status as 'pending' | 'processing' | 'completed' | 'failed',
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
    completedAt: result.completed_at as string,
    error: result.error_message as string,
    result: result.result ? JSON.parse(result.result as string) : undefined
  };
}

async function updateTaskStatus(
  db: D1Database, 
  taskId: string, 
  status: string, 
  error?: string, 
  result?: any
): Promise<boolean> {
  const now = new Date().toISOString();
  const completedAt = (status === 'completed' || status === 'failed') ? now : null;

  const updateResult = await db.prepare(`
    UPDATE vm_tasks 
    SET status = ?, updated_at = ?, completed_at = ?, error_message = ?, result = ?
    WHERE id = ?
  `)
  .bind(
    status,
    now,
    completedAt,
    error || null,
    result ? JSON.stringify(result) : null,
    taskId
  )
  .run();

  return updateResult.meta.changes > 0;
}


async function upsertVM(db: D1Database, vm: Partial<VM>): Promise<void> {
  const now = new Date().toISOString();
  
  await db.prepare(`
    INSERT INTO vms (
      id, name, ip_address, status, subdomain, port, created_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      ip_address = excluded.ip_address,
      status = excluded.status,
      subdomain = excluded.subdomain,
      port = excluded.port,
      updated_at = excluded.updated_at,
      metadata = excluded.metadata
  `)
  .bind(
    vm.id || uuidv4(),
    vm.name,
    vm.ipAddress || null,
    vm.status || 'unknown',
    vm.subdomain || null,
    vm.port || 8080,
    vm.createdAt || now,
    now,
    vm.metadata ? JSON.stringify(vm.metadata) : null
  )
  .run();
}

async function getVM(db: D1Database, vmName: string): Promise<VM | null> {
  const result = await db.prepare(`
    SELECT * FROM vms WHERE name = ?
  `).bind(vmName).first();

  if (!result) return null;

  return {
    id: result.id as string,
    name: result.name as string,
    ipAddress: result.ip_address as string,
    status: result.status as string,
    subdomain: result.subdomain as string,
    port: result.port as number,
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
    metadata: result.metadata ? JSON.parse(result.metadata as string) : undefined
  };
}

async function deleteVM(db: D1Database, vmName: string): Promise<boolean> {
  const result = await db.prepare(`
    DELETE FROM vms WHERE name = ?
  `).bind(vmName).run();

  return result.meta.changes > 0;
}

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'vm-api-worker',
    database: 'D1'
  });
});

// Database health check
app.get('/health/db', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT COUNT(*) as count FROM vm_tasks').first();
    return c.json({
      status: 'healthy',
      database: 'connected',
      totalTasks: result?.count || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      database: 'error',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    }, 500);
  }
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

    // Store task in D1 database
    await createTask(c.env.DB, task);
    
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
    const task = await getTask(c.env.DB, taskId);
    
    if (!task) {
      return c.json({
        success: false,
        error: 'Task not found'
      }, 404);
    }
    
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

// List all tasks with pagination and filtering
app.get('/vm/tasks', async (c) => {
  try {
    const status = c.req.query('status'); // Filter by status
    const vmName = c.req.query('vmName'); // Filter by VM name
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    let query = `
      SELECT 
        id, type, vm_name, status, created_at, updated_at, completed_at
      FROM vm_tasks 
    `;
    const params: any[] = [];
    const conditions: string[] = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    if (vmName) {
      conditions.push('vm_name LIKE ?');
      params.push(`%${vmName}%`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const result = await c.env.DB.prepare(query).bind(...params).all();

    const tasks = result.results.map(row => ({
      id: row.id,
      type: row.type,
      status: row.status,
      vmName: row.vm_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at
    }));

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM vm_tasks';
    const countParams: any[] = [];
    
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
      countParams.push(...params.slice(0, -2)); // Exclude limit and offset
    }

    const countResult = await c.env.DB.prepare(countQuery).bind(...countParams).first();
    const totalCount = Number(countResult?.total) || 0;

    return c.json({
      tasks,
      count: tasks.length,
      totalCount,
      pagination: {
        limit,
        offset,
        hasMore: offset + limit < totalCount
      }
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

    const updated = await updateTaskStatus(c.env.DB, taskId, status, error, result);
    
    if (!updated) {
      return c.json({
        success: false,
        error: 'Task not found'
      }, 404);
    }

    // If task completed with VM info, update VMs table
    if (status === 'completed' && result && result.subdomain) {
      await upsertVM(c.env.DB, {
        name: result.vmName,
        ipAddress: result.ip,
        status: 'running',
        subdomain: result.subdomain,
        port: 8080,
        metadata: result
      });
    }

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
    const task = await getTask(c.env.DB, taskId);
    
    if (!task) {
      return c.json({
        success: false,
        error: 'Task not found'
      }, 404);
    }
    
    if (task.status !== 'pending') {
      return c.json({
        success: false,
        error: `Cannot cancel task with status: ${task.status}`
      }, 400);
    }

    // Mark as cancelled
    await updateTaskStatus(c.env.DB, taskId, 'failed', 'Task cancelled by user');

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

// Get VM status and info
app.get('/vm/:vmName/status', async (c) => {
  try {
    const vmName = c.req.param('vmName');
    const vm = await getVM(c.env.DB, vmName);
    
    if (!vm) {
      return c.json({
        success: false,
        error: 'VM not found',
        vmName
      }, 404);
    }

    return c.json({
      success: true,
      vmName: vm.name,
      status: vm.status,
      ipAddress: vm.ipAddress,
      subdomain: vm.subdomain,
      port: vm.port,
      url: vm.subdomain ? `https://${vm.subdomain}` : null,
      createdAt: vm.createdAt,
      updatedAt: vm.updatedAt,
      metadata: vm.metadata
    });

  } catch (error) {
    console.error('Error getting VM status:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// List all VMs
app.get('/vms', async (c) => {
  try {
    const status = c.req.query('status');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    let query = 'SELECT * FROM vms';
    const params: any[] = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const result = await c.env.DB.prepare(query).bind(...params).all();

    const vms = result.results.map(row => ({
      id: row.id,
      name: row.name,
      ipAddress: row.ip_address,
      status: row.status,
      subdomain: row.subdomain,
      port: row.port,
      url: row.subdomain ? `https://${row.subdomain}` : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined
    }));

    return c.json({
      vms,
      count: vms.length
    });

  } catch (error) {
    console.error('Error listing VMs:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Delete VM record
app.delete('/vm/:vmName', async (c) => {
  try {
    const vmName = c.req.param('vmName');
    const deleted = await deleteVM(c.env.DB, vmName);
    
    if (!deleted) {
      return c.json({
        success: false,
        error: 'VM not found'
      }, 404);
    }

    return c.json({
      success: true,
      message: 'VM record deleted successfully',
      vmName
    });

  } catch (error) {
    console.error('Error deleting VM:', error);
    return c.json({
      success: false,
      error: 'Internal server error'
    }, 500);
  }
});

// Get dashboard statistics
app.get('/stats', async (c) => {
  try {
    const [taskStats, vmStats] = await Promise.all([
      c.env.DB.prepare(`
        SELECT 
          status,
          COUNT(*) as count
        FROM vm_tasks 
        GROUP BY status
      `).all(),
      c.env.DB.prepare(`
        SELECT 
          status,
          COUNT(*) as count
        FROM vms 
        GROUP BY status
      `).all()
    ]);

    const taskCounts = taskStats.results.reduce((acc, row) => {
      acc[row.status as string] = row.count;
      return acc;
    }, {} as Record<string, number>);

    const vmCounts = vmStats.results.reduce((acc, row) => {
      acc[row.status as string] = row.count;
      return acc;
    }, {} as Record<string, number>);

    return c.json({
      tasks: {
        pending: taskCounts.pending || 0,
        processing: taskCounts.processing || 0,
        completed: taskCounts.completed || 0,
        failed: taskCounts.failed || 0,
        total: Object.values(taskCounts).reduce((sum: number, count) => sum + (count as number), 0)
      },
      vms: {
        running: vmCounts.running || 0,
        stopped: vmCounts.stopped || 0,
        unknown: vmCounts.unknown || 0,
        total: Object.values(vmCounts).reduce((sum: number, count) => sum + (count as number), 0)
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error getting stats:', error);
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
    version: '2.0.0',
    database: 'Cloudflare D1',
    endpoints: {
      health: 'GET /health',
      dbHealth: 'GET /health/db',
      createTask: 'POST /vm/tasks',
      getTaskStatus: 'GET /vm/tasks/:taskId/status',
      listTasks: 'GET /vm/tasks',
      updateTaskStatus: 'PUT /vm/tasks/:taskId/status',
      cancelTask: 'DELETE /vm/tasks/:taskId',
      getVMStatus: 'GET /vm/:vmName/status',
      listVMs: 'GET /vms',
      deleteVM: 'DELETE /vm/:vmName',
      getStats: 'GET /stats'
    }
  });
});

export default app;