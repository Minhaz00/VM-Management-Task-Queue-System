import axios from 'axios';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

interface VMInfo {
  vmName: string;
  status: string;
  ip?: string;
  portForwards?: any[];
  subdomain?: string;
  demoUrl?: string;
}

class VMConsumer {
  private consumerUrl: string;
  private apiUrl: string;
  private arrakisUrl: string;
  private consumerId: string;
  private isRunning = false;
  private tunnelName: string;
  private tunnelConfigPath: string;
  private baseDomain: string;

  constructor() {
    this.consumerUrl = process.env.CONSUMER_WORKER_URL || 'https://vm-consumer-worker.poridhiaccess.workers.dev';
    this.apiUrl = process.env.API_WORKER_URL || 'https://vm-api-worker.poridhiaccess.workers.dev';
    this.arrakisUrl = process.env.ARRAKIS_URL || 'http://127.0.0.1:7000';
    this.consumerId = `consumer-${Date.now()}`;
    this.tunnelName = process.env.TUNNEL_NAME || 'arrakis-vm-tunnel';
    this.tunnelConfigPath = process.env.TUNNEL_CONFIG_PATH || '/etc/cloudflared/config.yml';
    this.baseDomain = process.env.BASE_DOMAIN || 'sandbox.puku.sh';
  }

  async start() {
    console.log('[INFO] Starting Automated VM Consumer...');
    console.log(`[INFO] Consumer Worker: ${this.consumerUrl}`);
    console.log(`[INFO] API Worker: ${this.apiUrl}`);
    console.log(`[INFO] Arrakis Server: ${this.arrakisUrl}`);
    console.log(`[INFO] Tunnel Name: ${this.tunnelName}`);
    console.log(`[INFO] Base Domain: ${this.baseDomain}`);

    this.isRunning = true;
    this.poll();

    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  private async poll() {
    while (this.isRunning) {
      try {
        await this.processTasks();
        await this.sleep(5000);
      } catch (error) {
        if (error instanceof Error) {
          console.error('[ERROR] Polling error:', error.message);
        } else {
          console.error('[ERROR] Polling error:', error);
        }
        await this.sleep(10000);
      }
    }
  }

  private async processTasks() {
    const response = await axios.get(`${this.consumerUrl}/tasks/ready`);
    const { tasks } = response.data;

    if (tasks.length === 0) {
      console.log('[INFO] No ready tasks');
      return;
    }

    console.log(`[INFO] Found ${tasks.length} ready task(s)`);

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

    const claimResponse = await axios.post(`${this.consumerUrl}/tasks/${taskId}/claim`, {
      consumerId: this.consumerId
    });

    if (!claimResponse.data.success) {
      console.log(`[WARN] Failed to claim task ${taskId}`);
      return;
    }

    const task: VMTask = claimResponse.data.task;
    console.log(`[INFO] Processing ${task.type} for VM: ${task.payload.vmName}`);

    await this.updateTaskStatus(taskId, 'processing');

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

    await this.updateTaskStatus(taskId, success ? 'completed' : 'failed', error, result);
    await axios.delete(`${this.consumerUrl}/tasks/${taskId}`);
    console.log(`[INFO] Task ${taskId} removed from buffer`);
  }

  private async executeTask(task: VMTask): Promise<any> {
    const { type, payload } = task;
    const { vmName } = payload;

    switch (type) {
      case 'launch_vm':
        return await this.launchVMWithAutomation(vmName, payload.vmConfig);
      
      case 'delete_vm':
        return await this.deleteVMWithCleanup(vmName);
      
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

  private async launchVMWithAutomation(vmName: string, config: any = {}): Promise<VMInfo> {
    console.log(`[INFO] Launching VM with full automation: ${vmName}`);
    
    // Step 1: Launch the VM
    const vmResult = await this.launchVM(vmName, config);
    
    // Step 2: Set up Node.js demo app
    await this.setupDemoApp(vmName, vmResult.ip);
    
    // Step 3: Create subdomain and update tunnel
    const subdomain = await this.setupTunnel(vmName, vmResult.ip);
    
    return {
      ...vmResult,
      subdomain,
      demoUrl: `https://${subdomain}`
    };
  }

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

    // Extract just the IP address from the response (remove CIDR if present)
    let vmIP = response.data.ip;
    if (vmIP && vmIP.includes('/')) {
      vmIP = vmIP.split('/')[0]; // Remove /24 or any CIDR notation
    }
    
    return {
      vmName,
      status: response.data.status,
      ip: vmIP,
      portForwards: response.data.portForwards
    };
  }

  private async setupDemoApp(vmName: string, vmIP: string) {
    console.log(`[INFO] Setting up demo Node.js app for VM: ${vmName}`);

    // Node.js demo app content
    const appContent = `const http = require('http');
const os = require('os');

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(\`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Arrakis VM Demo</title>
    </head>
    <body>
        <div class="container">
            <h1>Hello from Arrakis VM!</h1>
            <div class="info">
                <p><strong>VM Name:</strong> <span class="highlight">${vmName}</span></p>
                <p><strong>VM IP:</strong> <span class="highlight">${vmIP}</span></p>
                <p><strong>Hostname:</strong> <span class="highlight">\${os.hostname()}</span></p>
            </div>
        </div>
    </body>
    </html>
  \`);
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Demo server running on port 3000');
});`;

    try {
      // Upload the Node.js app via Arrakis
      await axios.post(`${this.arrakisUrl}/v1/vms/${vmName}/files`, {
        files: [
          {
            path: '/home/elara/app.js',
            content: appContent
          }
        ]
      });

      console.log(`[INFO] Demo app uploaded to VM: ${vmName}`);

      // Start the Node.js server (kill any existing first)
      await axios.post(`${this.arrakisUrl}/v1/vms/${vmName}/cmd`, {
        cmd: 'pkill -f "node.*app.js" || true',
        blocking: true
      });

      await this.sleep(2000); // Wait a bit

      await axios.post(`${this.arrakisUrl}/v1/vms/${vmName}/cmd`, {
        cmd: 'cd /home/elara && nohup node app.js > app.log 2>&1 &',
        blocking: false
      });

      console.log(`[INFO] Demo app started on VM: ${vmName}`);

      // Wait and verify it's running
      await this.sleep(3000);
      
      const checkResult = await axios.post(`${this.arrakisUrl}/v1/vms/${vmName}/cmd`, {
        cmd: 'curl -s http://localhost:3000 | head -n 5',
        blocking: true
      });

      if (checkResult.data.output && checkResult.data.output.includes('Arrakis VM')) {
        console.log(`[INFO] ✅ Demo app is running successfully on VM: ${vmName}`);
      } else {
        console.log(`[WARN] Demo app may not be running properly on VM: ${vmName}`);
      }

    } catch (error) {
      console.error(`[ERROR] Failed to setup demo app for VM: ${vmName}`, error);
      throw error;
    }
  }

  private async setupTunnel(vmName: string, vmIP: string): Promise<string> {
    console.log(`[INFO] Setting up tunnel for VM: ${vmName}`);

    // Generate subdomain (sanitize VM name)
    const sanitizedName = vmName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const subdomain = `${sanitizedName}.${this.baseDomain}`;

    try {
      // Read current tunnel config
      const configContent = await fs.readFile(this.tunnelConfigPath, 'utf-8');
      const lines = configContent.split('\n');

      // Find ingress section and add new entry
      const ingressIndex = lines.findIndex(line => line.includes('ingress:'));
      if (ingressIndex === -1) {
        throw new Error('Could not find ingress section in tunnel config');
      }

      // Create new ingress entry
      const newEntry = [
        `  - hostname: ${subdomain}`,
        `    service: http://${vmIP}:3000`
      ];

      // Insert after ingress line, before the catch-all
      const insertIndex = ingressIndex + 1;
      lines.splice(insertIndex, 0, ...newEntry);

      // Write updated config
      await fs.writeFile(this.tunnelConfigPath, lines.join('\n'));
      console.log(`[INFO] Updated tunnel config with subdomain: ${subdomain}`);

      // Add DNS record
      try {
        await execAsync(`cloudflared tunnel route dns ${this.tunnelName} ${subdomain}`);
        console.log(`[INFO] DNS record created for: ${subdomain}`);
      } catch (dnsError) {
        console.log(`[WARN] DNS record may already exist or failed to create: ${subdomain}`);
        // Continue anyway, DNS might already exist
      }

      // Restart cloudflared service to apply changes
      try {
        console.log(`[INFO] Restarting cloudflared service to apply changes...`);
        await execAsync('sudo systemctl restart cloudflared');
        
        // Wait a few seconds for service to start
        await this.sleep(1000);
        
        // Check if service is running
        const statusResult = await execAsync('sudo systemctl is-active cloudflared');
        if (statusResult.stdout.trim() === 'active') {
          console.log(`[INFO] ✅ Cloudflared service restarted successfully`);
        } else {
          console.log(`[WARN] Cloudflared service may not be running properly`);
        }
      } catch (restartError) {
        console.error(`[ERROR] Failed to restart cloudflared service:`, restartError);
        throw new Error(`Failed to restart tunnel service: ${restartError}`);
      }

      // Wait for tunnel to establish connections
      await this.sleep(3000);

      console.log(`[INFO] ✅ VM ${vmName} is now accessible at: https://${subdomain}`);
      
      // Verify the tunnel is working
      try {
        console.log(`[INFO] Testing tunnel connectivity for: ${subdomain}`);
        // Give it a moment for DNS to propagate
        await this.sleep(5000);
        
        // Test with curl (with timeout)
        await execAsync(`curl -m 10 -s https://${subdomain} > /dev/null`, { timeout: 15000 });
        console.log(`[INFO] ✅ Tunnel connectivity verified for: ${subdomain}`);
      } catch (testError) {
        console.log(`[WARN] Tunnel connectivity test failed for: ${subdomain} (may need more time for DNS propagation)`);
      }

      return subdomain;

    } catch (error) {
      console.error(`[ERROR] Failed to setup tunnel for VM: ${vmName}`, error);
      throw error;
    }
  }

  private async deleteVMWithCleanup(vmName: string) {
    console.log(`[INFO] Deleting VM with cleanup: ${vmName}`);

    try {
      // Delete the VM first
      await axios.delete(`${this.arrakisUrl}/v1/vms/${vmName}`);

      // Clean up tunnel config
      await this.cleanupTunnel(vmName);

      return {
        vmName,
        status: 'deleted',
        message: 'VM destroyed and tunnel cleaned up successfully'
      };
    } catch (error) {
      console.error(`[ERROR] Failed to delete VM with cleanup: ${vmName}`, error);
      throw error;
    }
  }

  private async cleanupTunnel(vmName: string) {
    console.log(`[INFO] Cleaning up tunnel config for VM: ${vmName}`);

    try {
      const sanitizedName = vmName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const subdomain = `${sanitizedName}.${this.baseDomain}`;

      // Read and update config to remove the subdomain entry
      const configContent = await fs.readFile(this.tunnelConfigPath, 'utf-8');
      const lines = configContent.split('\n');

      // Remove lines related to this subdomain
      const filteredLines = lines.filter(line => 
        !line.includes(subdomain) && 
        (!line.includes('service: http://') || !lines[lines.indexOf(line) - 1]?.includes(subdomain))
      );

      await fs.writeFile(this.tunnelConfigPath, filteredLines.join('\n'));
      console.log(`[INFO] Removed tunnel config for: ${subdomain}`);

      // Try to remove DNS record (may fail if already deleted)
      try {
        await execAsync(`cloudflared tunnel route dns delete ${subdomain}`);
        console.log(`[INFO] DNS record deleted for: ${subdomain}`);
      } catch (dnsError) {
        console.log(`[WARN] Failed to delete DNS record (may not exist): ${subdomain}`);
      }

      // Restart cloudflared service to apply changes
      try {
        console.log(`[INFO] Restarting cloudflared service after cleanup...`);
        await execAsync('sudo systemctl restart cloudflared');
        
        // Wait for service to start
        await this.sleep(3000);
        
        const statusResult = await execAsync('sudo systemctl is-active cloudflared');
        if (statusResult.stdout.trim() === 'active') {
          console.log(`[INFO] ✅ Cloudflared service restarted after cleanup`);
        }
      } catch (restartError) {
        console.error(`[ERROR] Failed to restart cloudflared service after cleanup:`, restartError);
      }

    } catch (error) {
      console.error(`[ERROR] Failed to cleanup tunnel for VM: ${vmName}`, error);
      // Don't throw here, VM is already deleted
    }
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
    console.log('[INFO] Stopping Automated VM Consumer...');
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