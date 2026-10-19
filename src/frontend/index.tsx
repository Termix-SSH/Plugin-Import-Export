import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentType,
} from "react";
import { Download, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  useTranslation,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  DropdownMenuItem,
  getErrorMessage,
  getSSHHosts,
  type SSHHostWithStatus,
} from "@termix-ssh/plugin-sdk/ui";
import { ExportDialog } from "./ExportDialog";
import { SAMPLE_HOSTS, downloadJson } from "./sample";

const MAX_IMPORT_HOSTS = 100;

type Command =
  | { type: "import"; overwrite: boolean }
  | { type: "ssh-config" }
  | { type: "export"; hostIds: string[] };

interface ImportResult {
  success?: number;
  updated?: number;
  failed?: number;
}

export function activate(app: TermixApp): void {
  // The menu items and the bulk action live in other surfaces; the file
  // pickers and the dialog live in the hosts panel. They talk through this.
  const listeners = new Set<(command: Command) => void>();
  const send = (command: Command) => {
    for (const listener of listeners) listener(command);
  };
  const hostsRef: { current: SSHHostWithStatus[] } = { current: [] };

  function ImportExportHost({
    hosts,
    onHostsChanged,
  }: {
    hosts: SSHHostWithStatus[];
    onHostsChanged: (hosts: SSHHostWithStatus[]) => void;
  }) {
    const { t } = useTranslation();
    const jsonInput = useRef<HTMLInputElement>(null);
    const configInput = useRef<HTMLInputElement>(null);
    const overwrite = useRef(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [preselected, setPreselected] = useState<Set<string>>(new Set());
    hostsRef.current = hosts;

    useEffect(() => {
      const listener = (command: Command) => {
        if (command.type === "import") {
          overwrite.current = command.overwrite;
          jsonInput.current?.click();
        } else if (command.type === "ssh-config") {
          overwrite.current = false;
          configInput.current?.click();
        } else {
          setPreselected(new Set(command.hostIds));
          setExportOpen(true);
        }
      };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);

    const refresh = async () => {
      onHostsChanged(await getSSHHosts());
      window.dispatchEvent(new CustomEvent("termix:hosts-changed"));
    };

    const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      event.target.value = "";
      try {
        const parsed = JSON.parse(await file.text());
        const hostsArray = Array.isArray(parsed)
          ? parsed
          : (parsed.hosts ?? []);
        const credentials =
          !Array.isArray(parsed) && Array.isArray(parsed.credentials)
            ? parsed.credentials
            : undefined;
        if (!Array.isArray(hostsArray) || hostsArray.length === 0) {
          toast.error(t("hosts.importNoHosts"));
          return;
        }
        if (hostsArray.length > MAX_IMPORT_HOSTS) {
          toast.error(t("hosts.importTooMany", { max: MAX_IMPORT_HOSTS }));
          return;
        }
        const normalized = hostsArray.map((h: Record<string, unknown>) => ({
          ...h,
          port: h.port ?? h.sshPort ?? 22,
          enableSsh: h.enableSsh ?? h.connectionType === "ssh",
        }));
        const { data } = await app.api.post<ImportResult>("/bulk-import", {
          hosts: normalized,
          overwrite: overwrite.current,
          credentials,
        });
        await refresh();
        toast.success(
          t("hosts.importSummary", {
            imported: data.success ?? 0,
            updated: data.updated ?? 0,
            failed: data.failed ?? 0,
          }),
        );
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, t("hosts.importHostsFailed")));
      }
    };

    const importConfig = async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      event.target.value = "";
      try {
        const { data } = await app.api.post<ImportResult>(
          "/ssh-config-import",
          { content: await file.text(), overwrite: overwrite.current },
        );
        await refresh();
        toast.success(
          t("hosts.importSummary", {
            imported: data.success ?? 0,
            updated: data.updated ?? 0,
            failed: data.failed ?? 0,
          }),
        );
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, t("hosts.importConfigFailed")));
      }
    };

    return (
      <>
        <input
          ref={jsonInput}
          type="file"
          accept=".json"
          className="hidden"
          onChange={importJson}
        />
        <input
          ref={configInput}
          type="file"
          accept=".conf,.config,*"
          className="hidden"
          onChange={importConfig}
        />
        <ExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          hosts={hosts}
          preselectedHostIds={preselected}
          api={app.api}
        />
      </>
    );
  }

  function ImportMenu() {
    const { t } = useTranslation();
    return (
      <>
        <DropdownMenuItem
          onClick={() => send({ type: "import", overwrite: false })}
        >
          <Upload className="size-3.5 mr-2" />
          {t("hosts.importSkipExisting")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => send({ type: "import", overwrite: true })}
        >
          <Upload className="size-3.5 mr-2" />
          {t("hosts.importOverwrite")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => send({ type: "ssh-config" })}>
          <Upload className="size-3.5 mr-2" />
          {t("hosts.importSSHConfig")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => send({ type: "export", hostIds: [] })}
          disabled={hostsRef.current.length === 0}
        >
          <Download className="size-3.5 mr-2" />
          {t("hosts.export.menuItem")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => downloadJson("termix-hosts-sample.json", SAMPLE_HOSTS)}
        >
          <Download className="size-3.5 mr-2" />
          {t("hosts.downloadSample")}
        </DropdownMenuItem>
      </>
    );
  }

  // Actions carry the permission, so the slots hide everything from users
  // who may not use the plugin.
  const gate = { permission: "use" };
  app.registerAction("import-export.panel", () => undefined, gate);
  app.registerAction("import-export.menu", () => undefined, gate);

  app.registerSlotContribution("hosts.panel", {
    actionId: "import-export.panel",
    titleKey: "hosts.importExportBtn",
    kind: "component",
    component: ImportExportHost as unknown as ComponentType<
      Record<string, unknown>
    >,
  });

  app.registerSlotContribution("hosts.importMenu", {
    actionId: "import-export.menu",
    titleKey: "hosts.importExportBtn",
    kind: "component",
    order: 0,
    component: ImportMenu as ComponentType<Record<string, unknown>>,
  });

  app.registerAction(
    "import-export.exportSelected",
    (hostIds: string[]) => {
      send({ type: "export", hostIds });
    },
    gate,
  );
  app.registerSlotContribution("hosts.selectionActions", {
    actionId: "import-export.exportSelected",
    titleKey: "hosts.export.bulkButton",
    icon: Download as never,
  });
}
