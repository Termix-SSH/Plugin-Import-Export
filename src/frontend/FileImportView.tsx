import { useRef, useState, type ChangeEvent } from "react";
import { Download, FileUp } from "lucide-react";
import { toast } from "sonner";
import {
  useTranslation,
  type PluginApiClient,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  InlineView,
  SectionCard,
  getErrorMessage,
} from "@termix-ssh/plugin-sdk/ui";
import { SAMPLE_HOSTS, downloadJson } from "./sample";

const MAX_IMPORT_HOSTS = 100;

interface ImportResult {
  success?: number;
  updated?: number;
  failed?: number;
}

/**
 * Imports a Termix JSON file or an SSH config file. A file picker only
 * opens from a click inside the plugin's own view, so this view holds it.
 */
export function FileImportView({
  api,
  kind,
  overwrite,
  onClose,
  onImported,
}: {
  api: PluginApiClient;
  kind: "json" | "ssh";
  overwrite: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const done = (data: ImportResult) => {
    toast.success(
      t("hosts.importSummary", {
        imported: data.success ?? 0,
        updated: data.updated ?? 0,
        failed: data.failed ?? 0,
      }),
    );
    onImported();
    onClose();
  };

  async function importJson(text: string) {
    const parsed = JSON.parse(text);
    const hosts = Array.isArray(parsed) ? parsed : (parsed.hosts ?? []);
    const credentials =
      !Array.isArray(parsed) && Array.isArray(parsed.credentials)
        ? parsed.credentials
        : undefined;
    if (!Array.isArray(hosts) || hosts.length === 0) {
      toast.error(t("hosts.importNoHosts"));
      return;
    }
    if (hosts.length > MAX_IMPORT_HOSTS) {
      toast.error(t("hosts.importTooMany", { max: MAX_IMPORT_HOSTS }));
      return;
    }
    const normalized = hosts.map((h: Record<string, unknown>) => ({
      ...h,
      port: h.port ?? h.sshPort ?? 22,
      enableSsh: h.enableSsh ?? h.connectionType === "ssh",
    }));
    const { data } = await api.post<ImportResult>("/bulk-import", {
      hosts: normalized,
      overwrite,
      credentials,
    });
    done(data);
  }

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      if (kind === "json") {
        await importJson(text);
      } else {
        const { data } = await api.post<ImportResult>("/ssh-config-import", {
          content: text,
          overwrite,
        });
        done(data);
      }
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t(
            kind === "json"
              ? "hosts.importHostsFailed"
              : "hosts.importConfigFailed",
          ),
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const title =
    kind === "ssh"
      ? t("hosts.importSSHConfig")
      : overwrite
        ? t("hosts.importOverwrite")
        : t("hosts.importSkipExisting");

  return (
    <InlineView
      stacked
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<FileUp className="size-4" />}
      title={title}
    >
      <SectionCard title={t("fileImport.file")} icon={<FileUp />}>
        <div className="flex flex-col gap-3 py-2">
          <p className="text-xs text-muted-foreground">
            {t(
              kind === "ssh"
                ? "fileImport.sshHint"
                : overwrite
                  ? "fileImport.jsonOverwriteHint"
                  : "fileImport.jsonHint",
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <FileUp className="size-3.5" />
              {busy ? t("fileImport.importing") : t("fileImport.pick")}
            </Button>
            {kind === "json" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadJson("termix-hosts-sample.json", SAMPLE_HOSTS)
                }
              >
                <Download className="size-3.5" />
                {t("hosts.downloadSample")}
              </Button>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept={kind === "json" ? ".json" : ".conf,.config,*"}
            className="hidden"
            onChange={(e) => void pick(e)}
          />
        </div>
      </SectionCard>
    </InlineView>
  );
}
