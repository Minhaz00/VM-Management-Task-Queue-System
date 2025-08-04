import axios from 'axios';

interface VMTask {
  id: string;
  type: 'launch_vm' | 'delete_vm' | 'stop_vm' | 'pause_vm' | 'snapshot_vm' | 'run_command';
  payload: {
    vmName: string;
    vmConfig?: any;
    snapshotId?: string;
    command?: string;
    blocking?: boolean;
  };
}

class VMConsumer {
  private consumerUrl: string;
  private apiUrl: string;
  private arrakisUrl: string;
  private consumerId: string;
  private isRunning = false;

  constructor() {
    this.consumerUrl = process.env.CONSUMER_WORKER_URL || 'https://vm-consumer-worker.poridhiaccess.workers.dev';
    this.apiUrl = process.env.API_WORKER_URL || 'https://vm-api-worker.poridhiaccess.workers.dev';
    this.arrakisUrl = process.env.ARRAKIS_URL || 'http://127.0.0.1:7000';
    this.consumerId = `consumer-${Date.now()}`;
  }

  async start() {
    console.log('[INFO] Starting VM Consumer...');
    console.log(`[INFO] Consumer Worker: ${this.consumerUrl}`);
    console.log(`[INFO] API Worker: ${this.apiUrl}`);
    console.log(`[INFO] Arrakis Server: ${this.arrakisUrl}`);

    this.isRunning = true;
    this.poll();

    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  private async poll() {
    while (this.isRunning) {
      try {
        await this.processTasks();
        await this.sleep(5000); // Poll every 5 seconds
      } catch (error) {
        if (error instanceof Error) {
          console.error('[ERROR] Polling error:', error.message);
        } else {
          console.error('[ERROR] Polling error:', error);
        }
        await this.sleep(10000); // Wait longer on error
      }
    }
  }

  private async processTasks() {
    // Get ready tasks
    const response = await axios.get(`${this.consumerUrl}/tasks/ready`);
    const { tasks } = response.data;

    if (tasks.length === 0) {
      console.log('[INFO] No ready tasks');
      return;
    }

    console.log(`[INFO] Found ${tasks.length} ready task(s)`);

    // Process each task
    for (const taskSummary of tasks) {
      try {
        await this.processTask(taskSummary.id);
      } catch (error) {
        if (error instanceof Error) {
          console.error(`[ERROR] Failed to process task ${taskSummary.id}:`, error.message);
        } else {
          console.error(`[ERROR] Failed to process task ${taskSummary.id}:`, error);
        }
      }
    }
  }

  private async processTask(taskId: string) {
    console.log(`[INFO] Claiming task: ${taskId}`);

    // Claim the task
    const claimResponse = await axios.post(`${this.consumerUrl}/tasks/${taskId}/claim`, {
      consumerId: this.consumerId
    });

    if (!claimResponse.data.success) {
      console.log(`[WARN] Failed to claim task ${taskId}`);
      return;
    }

    const task: VMTask = claimResponse.data.task;
    console.log(`[INFO] Processing ${task.type} for VM: ${task.payload.vmName}`);

    // Update status to processing
    await this.updateTaskStatus(taskId, 'processing');

    // Execute the task
    let result: any;
    let success = false;
    let error: string | undefined = undefined;

    try {
      result = await this.executeTask(task);
      success = true;
      console.log(`[INFO] Task ${taskId} completed successfully`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] Task ${taskId} failed:`, error);
    }

    // Report completion
    await this.updateTaskStatus(taskId, success ? 'completed' : 'failed', error, result);

    // Remove from buffer
    await axios.delete(`${this.consumerUrl}/tasks/${taskId}`);
    console.log(`[INFO] Task ${taskId} removed from buffer`);
  }

  private async executeTask(task: VMTask): Promise<any> {
    const { type, payload } = task;
    const { vmName } = payload;

    switch (type) {
      case 'launch_vm':
        return await this.launchVM(vmName, payload.vmConfig);
      
      case 'delete_vm':
        return await this.deleteVM(vmName);
      
      case 'stop_vm':
        return await this.stopVM(vmName);
      
      case 'pause_vm':
        return await this.pauseVM(vmName);
      
      case 'snapshot_vm':
        if (!payload.snapshotId) {
          throw new Error('Snapshot ID is required');
        }
        return await this.snapshotVM(vmName, payload.snapshotId);
      
      case 'run_command':
        if (!payload.command) {
          throw new Error('Command is required');
        }
        return await this.runCommand(vmName, payload.command, payload.blocking);
      
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
  }

  // Arrakis API Methods
  private async launchVM(vmName: string, config: any = {}) {
    console.log(`[INFO] Launching VM: ${vmName}`);
    
    const vmConfig = {
      vmName,
      kernel: config.kernel || process.env.DEFAULT_KERNEL,
      rootfs: config.rootfs || process.env.DEFAULT_ROOTFS,
      initramfs: config.initramfs || process.env.DEFAULT_INITRAMFS,
      ...config
    };

    // Remove undefined values
    Object.keys(vmConfig).forEach(key => {
      if (vmConfig[key] === undefined) delete vmConfig[key];
    });

    const response = await axios.post(`${this.arrakisUrl}/v1/vms`, vmConfig);
    
    return {
      vmName,
      status: response.data.status,
      ip: response.data.ip,
      portForwards: response.data.portForwards
    };
  }

  private async deleteVM(vmName: string) {
    console.log(`[INFO] Deleting VM: ${vmName}`);
    
    await axios.delete(`${this.arrakisUrl}/v1/vms/${vmName}`);
    
    return {
      vmName,
      status: 'deleted',
      message: 'VM destroyed successfully'
    };
  }

  private async stopVM(vmName: string) {
    console.log(`[INFO] Stopping VM: ${vmName}`);
    
    await axios.patch(`${this.arrakisUrl}/v1/vms/${vmName}`, {
      status: 'stopped'
    });
    
    return {
      vmName,
      status: 'stopped',
      message: 'VM stopped successfully'
    };
  }

  private async pauseVM(vmName: string) {
    console.log(`[INFO] Pausing VM: ${vmName}`);
    
    await axios.patch(`${this.arrakisUrl}/v1/vms/${vmName}`, {
      status: 'paused'
    });
    
    return {
      vmName,
      status: 'paused',
      message: 'VM paused successfully'
    };
  }

  private async snapshotVM(vmName: string, snapshotId: string) {
    if (!snapshotId) throw new Error('Snapshot ID is required');
    
    console.log(`[INFO] Creating snapshot ${snapshotId} for VM: ${vmName}`);
    
    await axios.post(`${this.arrakisUrl}/v1/vms/${vmName}/snapshots`, {
      snapshotId
    });
    
    return {
      vmName,
      snapshotId,
      status: 'snapshot_created',
      message: 'Snapshot created successfully'
    };
  }

  private async runCommand(vmName: string, command: string, blocking = true) {
    if (!command) throw new Error('Command is required');
    
    console.log(`[INFO] Running command in VM ${vmName}: ${command}`);
    
    const response = await axios.post(`${this.arrakisUrl}/v1/vms/${vmName}/cmd`, {
      cmd: command,
      blocking
    });
    
    return {
      vmName,
      command,
      output: response.data.output,
      error: response.data.error
    };
  }

  private async updateTaskStatus(taskId: string, status: string, error?: string, result?: any) {
    try {
      const payload: any = { status };
      if (error) payload.error = error;
      if (result) payload.result = result;

      await axios.put(`${this.apiUrl}/vm/tasks/${taskId}/status`, payload);
    } catch (err) {
      if (err instanceof Error) {
        console.error(`[ERROR] Failed to update task ${taskId} status:`, err.message);
      } else {
        console.error(`[ERROR] Failed to update task ${taskId} status:`, String(err));
      }
    }
  }

  private async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private stop() {
    console.log('[INFO] Stopping VM Consumer...');
    this.isRunning = false;
    process.exit(0);
  }
}

// Start the consumer
const consumer = new VMConsumer();
consumer.start().catch(error => {
  console.error('[ERROR] Failed to start consumer:', error);
  process.exit(1);
});