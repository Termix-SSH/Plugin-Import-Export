import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ImportFormatError,
  detectFormat,
  parseApp,
  parseAuto,
  toTermixRow,
} from "../../src/backend/importers/index.js";
import { parseCsv } from "../../src/backend/importers/csv.js";

const file = (content: string, name = "export") => [{ name, content }];

describe("Termius and other CSV", () => {
  it("reads the Termius import template", () => {
    const csv =
      "\uFEFFGroups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password\r\n" +
      'Prod/Web,web-1,"nginx,prod",10.0.0.5,ssh,2222,deploy,"p,w""d"\r\n' +
      ",bastion,,admin@10.0.0.1,,,,\r\n" +
      "Lab,switch,,10.0.0.9,telnet,,,\r\n" +
      "Lab,odd,,10.0.0.10,serial,,,\r\n" +
      ",empty,,,ssh,22,root,\r\n";
    expect(detectFormat(file(csv))).toBe("termius");
    const out = parseApp("termius", file(csv));
    expect(out.hosts).toEqual([
      {
        name: "web-1",
        ip: "10.0.0.5",
        port: 2222,
        username: "deploy",
        folder: ["Prod", "Web"],
        tags: ["nginx", "prod"],
        notes: "",
        connectionType: "ssh",
        password: 'p,w"d',
      },
      expect.objectContaining({
        name: "bastion",
        ip: "10.0.0.1",
        username: "admin",
        port: 22,
      }),
      expect.objectContaining({
        name: "switch",
        connectionType: "telnet",
        port: 23,
        folder: ["Lab"],
      }),
    ]);
    expect(out.skipped).toEqual([
      { name: "odd", code: "protocol", detail: "serial" },
      { name: "empty", code: "noHost" },
    ]);
  });

  it("reads the exporter layout with a key column", () => {
    const csv =
      'Label,Host,Port,Username,Password,SSH_Key,OS\n"db","10.1.1.1","22","pg","","prod-key","linux"\n';
    const out = parseApp("termius", file(csv));
    expect(out.hosts[0]).toMatchObject({
      name: "db",
      ip: "10.1.1.1",
      username: "pg",
      notes: "Key: prod-key",
    });
    expect(out.hosts[0].password).toBeUndefined();
  });

  it("splits quoted cells with newlines and semicolon files", () => {
    expect(parseCsv('a;b\n"x\ny";2\n')).toEqual([
      ["a", "b"],
      ["x\ny", "2"],
    ]);
  });
});

describe("MobaXterm", () => {
  const moba = [
    "[Bookmarks]",
    "SubRep=",
    "ImgNum=42",
    "router=#109#0%192.168.1.1%22%admin%%-1%-1%%%22%%0%0%0%_MyDocuments_\\keys\\router.ppk%%-1%0%0%0%%1080%0%0%1#MobaFont%10%0%0%0%15%236,236,236%0,0,0%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0#0# #-1",
    "",
    "[Bookmarks_1]",
    "SubRep=Prod\\Windows",
    "ImgNum=41",
    "dc01=#91#4%10.0.0.20%3390%Administrator%0%-1%0%0%-1%0%0%-1%0%0%0%0%-1%0#MobaFont%10%0%0%0%15#0# #-1",
    "vnc box=#128#5%10.0.0.30%5901%%0%-1%%#MobaFont#0# #-1",
    "local shell=#100#2%Bash%%0%%%#MobaFont#0# #-1",
  ].join("\r\n");

  it("reads sessions, folders and ports", () => {
    expect(detectFormat(file(moba))).toBe("mobaxterm");
    const out = parseApp("mobaxterm", file(moba));
    expect(out.hosts).toEqual([
      {
        name: "router",
        ip: "192.168.1.1",
        port: 22,
        username: "admin",
        folder: [],
        tags: [],
        notes: "Key: _MyDocuments_\\keys\\router.ppk",
        connectionType: "ssh",
      },
      expect.objectContaining({
        name: "dc01",
        ip: "10.0.0.20",
        port: 3390,
        username: "Administrator",
        folder: ["Prod", "Windows"],
        connectionType: "rdp",
      }),
      expect.objectContaining({
        name: "vnc box",
        port: 5901,
        connectionType: "vnc",
        username: "",
      }),
    ]);
    expect(out.skipped).toEqual([
      { name: "local shell", code: "protocol", detail: "Shell" },
    ]);
  });
});

describe("PuTTY", () => {
  const reg = [
    "Windows Registry Editor Version 5.00",
    "",
    "[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]",
    '"HostName"=""',
    "",
    "[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\My%20Server]",
    '"HostName"="root@10.0.0.7"',
    '"PortNumber"=dword:00000016',
    '"Protocol"="ssh"',
    '"PublicKeyFile"="C:\\\\Users\\\\me\\\\.ssh\\\\id.ppk"',
    "",
    "[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\switch]",
    '"HostName"="10.0.0.8"',
    '"PortNumber"=dword:00000017',
    '"UserName"="ops"',
    '"Protocol"="telnet"',
    "",
    "[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\com1]",
    '"HostName"="COM1"',
    '"Protocol"="serial"',
    "",
    "[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\SshHostKeys]",
    '"ssh-ed25519@22:10.0.0.7"="0x1234"',
  ].join("\r\n");

  it("reads sessions from a registry export", () => {
    expect(detectFormat(file(reg))).toBe("putty");
    const out = parseApp("putty", file(reg));
    expect(out.hosts).toEqual([
      {
        name: "My Server",
        ip: "10.0.0.7",
        port: 22,
        username: "root",
        folder: [],
        tags: [],
        notes: "Key: C:\\Users\\me\\.ssh\\id.ppk",
        connectionType: "ssh",
      },
      expect.objectContaining({
        name: "switch",
        port: 23,
        username: "ops",
        connectionType: "telnet",
      }),
    ]);
    expect(out.skipped).toEqual([
      { name: "com1", code: "protocol", detail: "serial" },
    ]);
  });
});

describe("SecureCRT", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="Default">
      <string name="Hostname"></string>
    </key>
    <key name="Prod">
      <key name="__FolderData__"><string name="Is Expanded">1</string></key>
      <key name="Web">
        <key name="web-1">
          <string name="Hostname">10.2.0.1</string>
          <string name="Protocol Name">SSH2</string>
          <dword name="[SSH2] Port">2200</dword>
          <string name="Username">www</string>
          <string name="Description">front &amp; back</string>
        </key>
      </key>
      <key name="router">
        <string name="Hostname">10.2.0.254</string>
        <string name="Protocol Name">Telnet</string>
        <dword name="Port">23</dword>
      </key>
      <key name="modem">
        <string name="Protocol Name">Serial</string>
        <string name="Hostname"></string>
      </key>
    </key>
  </key>
</VanDyke>`;

  it("reads the exported XML with its folders", () => {
    expect(detectFormat(file(xml))).toBe("securecrt");
    const out = parseApp("securecrt", file(xml));
    expect(out.hosts).toEqual([
      {
        name: "web-1",
        ip: "10.2.0.1",
        port: 2200,
        username: "www",
        folder: ["Prod", "Web"],
        tags: [],
        notes: "front & back",
        connectionType: "ssh",
      },
      expect.objectContaining({
        name: "router",
        connectionType: "telnet",
        port: 23,
        folder: ["Prod"],
      }),
    ]);
    expect(out.skipped).toEqual([{ name: "modem", code: "noHost" }]);
  });

  it("reads session .ini files with the folder from their path", () => {
    const ini = [
      'S:"Protocol Name"=SSH2',
      'S:"Hostname"=10.3.0.1',
      'S:"Username"=admin',
      'D:"[SSH2] Port"=00000016',
    ].join("\r\n");
    const out = parseApp("securecrt", [
      { name: "Config/Sessions/Lab/db.ini", content: ini },
      { name: "Config/Sessions/Default.ini", content: ini },
    ]);
    expect(out.hosts).toEqual([
      expect.objectContaining({
        name: "db",
        ip: "10.3.0.1",
        port: 22,
        username: "admin",
        folder: ["Lab"],
      }),
    ]);
  });
});

/** Encrypts like mRemoteNG's AeadCryptographyProvider. */
function mrngEncrypt(text: string, password: string, iterations = 1000) {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(
    Buffer.from(password, "latin1"),
    salt,
    iterations,
    32,
    "sha1",
  );
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(salt);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([salt, nonce, body, cipher.getAuthTag()]).toString(
    "base64",
  );
}

/** Encrypts like the pre 1.75 Rijndael provider. */
function mrngLegacyEncrypt(text: string, password: string) {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash("md5").update(password, "utf8").digest();
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(text, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

function confCons(
  password: string,
  options: { iterations?: number; fullFile?: boolean; legacy?: boolean } = {},
) {
  const iterations = options.iterations ?? 1000;
  const enc = (value: string) =>
    options.legacy
      ? mrngLegacyEncrypt(value, password)
      : mrngEncrypt(value, password, iterations);
  const nodes = `<Node Name="Servers" Type="Container" Expanded="true" Descr="" Icon="mRemoteNG" Panel="General" Id="f1">
    <Node Name="app" Type="Connection" Descr="App server" Icon="SSH" Panel="General" Id="c1" Username="deploy" Domain="" Password="${enc("s3cret!")}" Hostname="10.4.0.1" Protocol="SSH2" Port="22" />
    <Node Name="dc" Type="Connection" Descr="" Icon="RDP" Panel="General" Id="c2" Username="Administrator" Domain="CORP" Password="" Hostname="10.4.0.2" Protocol="RDP" Port="3389" />
    <Node Name="intranet" Type="Connection" Hostname="intranet" Protocol="HTTPS" Port="443" Id="c3" />
  </Node>`;
  const attrs = options.legacy
    ? `Name="Connections" Export="false" Protected="${enc(password === "mR3m" ? "ThisIsNotProtected" : "ThisIsProtected")}" ConfVersion="2.6"`
    : `Name="Connections" Export="false" EncryptionEngine="AES" BlockCipherMode="GCM" KdfIterations="${iterations}" FullFileEncryption="${options.fullFile ? "true" : "false"}" Protected="${enc(password === "mR3m" ? "ThisIsNotProtected" : "ThisIsProtected")}" ConfVersion="2.6"`;
  return `<?xml version="1.0" encoding="utf-8"?>
<mrng:Connections xmlns:mrng="http://mremoteng.org" ${attrs}>${options.fullFile ? enc(nodes) : nodes}</mrng:Connections>`;
}

describe("mRemoteNG", () => {
  it("decrypts passwords with the default master password", () => {
    const xml = confCons("mR3m");
    expect(detectFormat(file(xml))).toBe("mremoteng");
    const out = parseApp("mremoteng", file(xml));
    expect(out.hosts).toEqual([
      {
        name: "app",
        ip: "10.4.0.1",
        port: 22,
        username: "deploy",
        folder: ["Servers"],
        tags: [],
        notes: "App server",
        connectionType: "ssh",
        password: "s3cret!",
      },
      expect.objectContaining({
        name: "dc",
        connectionType: "rdp",
        notes: "Domain: CORP",
      }),
    ]);
    expect(out.hosts[1].password).toBeUndefined();
    expect(out.skipped).toEqual([
      { name: "intranet", code: "protocol", detail: "HTTPS" },
    ]);
  });

  it("asks for a custom master password and refuses a wrong one", () => {
    const xml = confCons("Corp-Pass-1", { iterations: 10000 });
    expect(() => parseApp("mremoteng", file(xml))).toThrow(
      expect.objectContaining({ code: "needsPassword" }),
    );
    expect(() => parseApp("mremoteng", file(xml), "nope")).toThrow(
      expect.objectContaining({ code: "wrongPassword" }),
    );
    const out = parseApp("mremoteng", file(xml), "Corp-Pass-1");
    expect(out.hosts[0].password).toBe("s3cret!");
  });

  it("opens fully encrypted files", () => {
    const out = parseApp(
      "mremoteng",
      file(confCons("mR3m", { fullFile: true })),
    );
    expect(out.hosts.map((h) => h.name)).toEqual(["app", "dc"]);
  });

  it("reads files from before 1.75", () => {
    const out = parseApp("mremoteng", file(confCons("mR3m", { legacy: true })));
    expect(out.hosts[0].password).toBe("s3cret!");
  });
});

describe("parseAuto", () => {
  it("refuses files from apps it does not know", () => {
    expect(() => parseAuto(file("hello"), null)).toThrow(ImportFormatError);
  });

  it("refuses broken XML", () => {
    expect(() => parseAuto(file("<VanDyke><key"), "securecrt")).toThrow(
      expect.objectContaining({ code: "unreadable" }),
    );
  });
});

describe("toTermixRow", () => {
  it("fills the username of SSH hosts that have none and joins folders", () => {
    const row = toTermixRow(
      {
        name: "a",
        ip: "10.0.0.1",
        port: 22,
        username: "",
        folder: ["Prod", "Web"],
        tags: [],
        notes: "",
        connectionType: "ssh",
      },
      "root",
    );
    expect(row).toMatchObject({
      username: "root",
      folder: "Prod / Web",
      authType: "none",
      enableSsh: true,
    });
  });

  it("keeps RDP hosts out of SSH and carries the password", () => {
    const row = toTermixRow(
      {
        name: "dc",
        ip: "10.0.0.2",
        port: 3389,
        username: "",
        folder: [],
        tags: [],
        notes: "",
        connectionType: "rdp",
        password: "x",
      },
      "root",
    );
    expect(row).toMatchObject({
      username: "",
      connectionType: "rdp",
      authType: "password",
      password: "x",
      enableSsh: false,
    });
  });
});
