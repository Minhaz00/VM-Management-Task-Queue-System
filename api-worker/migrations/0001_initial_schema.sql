-- Create tasks table
CREATE TABLE IF NOT EXISTS vm_tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('launch_vm', 'delete_vm')),
    vm_name TEXT NOT NULL,
    vm_config TEXT, -- JSON string for VM configuration
    target_server TEXT DEFAULT 'default',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    error_message TEXT,
    result TEXT -- JSON string for task results
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_vm_tasks_status ON vm_tasks(status);
CREATE INDEX IF NOT EXISTS idx_vm_tasks_created_at ON vm_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_vm_tasks_vm_name ON vm_tasks(vm_name);
CREATE INDEX IF NOT EXISTS idx_vm_tasks_type ON vm_tasks(type);

-- Create VMs info table (optional - for tracking active VMs)
CREATE TABLE IF NOT EXISTS vms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    subdomain TEXT,
    port INTEGER DEFAULT 8080,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT -- JSON string for additional VM info
);

CREATE INDEX IF NOT EXISTS idx_vms_name ON vms(name);
CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status);