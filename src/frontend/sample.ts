/** The file the Download Sample menu item saves. */
export const SAMPLE_HOSTS = {
  hosts: [
    {
      name: "Web Server (Production)",
      ip: "192.168.1.100",
      username: "admin",
      authType: "password",
      password: "your_secure_password_here",
      folder: "Production",
      tags: ["web", "production", "nginx"],
      pin: true,
      notes: "Main production web server running Nginx",
      enableSsh: true,
      sshPort: 22,
      enableTerminal: true,
      enableTunnel: false,
      enableFileManager: true,
      defaultPath: "/var/www",
    },
    {
      name: "Database Server",
      ip: "192.168.1.101",
      username: "dbadmin",
      authType: "key",
      key: "-----BEGIN OPENSSH PRIVATE KEY-----\nYour SSH private key content here\n-----END OPENSSH PRIVATE KEY-----",
      keyPassword: "optional_key_passphrase",
      keyType: "ssh-ed25519",
      folder: "Production",
      tags: ["database", "production", "postgresql"],
      enableSsh: true,
      sshPort: 22,
      enableTerminal: true,
      enableTunnel: true,
      enableFileManager: false,
    },
  ],
};

export function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
