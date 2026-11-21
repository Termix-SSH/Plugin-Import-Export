import { useRef, useState, type ChangeEvent } from "react";
import {
  FileUp,
  FolderOpen,
  Monitor,
  Server,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import {
  useTranslation,
  type PluginApiClient,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  FormFooter,
  InlineView,
  Input,
  ListRow,
  LoadingState,
  PanelList,
  SectionCard,
  SelectField,
  SwitchRow,
  TextField,
  getErrorMessage,
} from "@termix-ssh/plugin-sdk/ui";
import {
  APP_FORMATS,
  readImportFiles,
  type AppFormat,
  type AppImportResult,
  type Preview,
} from "./app-import";

type Files = Array<{ name: string; content: string }>;

/** Imports hosts from Termius, MobaXterm, PuTTY, SecureCRT or mRemoteNG. */
export function AppImportView({
  api,
  onClose,
  onImported,
}: {
  api: PluginApiClient;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<AppFormat | "auto">("auto");
  const [files, setFiles] = useState<Files>([]);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [defaultUsername, setDefaultUsername] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const body = (extra: Record<string, unknown> = {}) => ({
    files,
    format,
    password: password || undefined,
    defaultUsername,
    overwrite,
    ...extra,
  });

  async function loadPreview(
    next: Files,
    nextFormat = format,
    pass = password,
  ) {
    if (next.length === 0) return;
    setLoading(true);
    setPreview(null);
    setErrors([]);
    try {
      const { data } = await api.post<Preview & { needsPassword?: boolean }>(
        "/app-import",
        {
          files: next,
          format: nextFormat,
          password: pass || undefined,
          preview: true,
        },
      );
      if (data.needsPassword) {
        setNeedsPassword(true);
        return;
      }
      setPreview(data);
    } catch (error) {
      toast.error(getErrorMessage(error, t("appImport.readFailed")));
    } finally {
      setLoading(false);
    }
  }

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files;
    if (!picked || picked.length === 0) return;
    const next = await readImportFiles(Array.from(picked));
    event.target.value = "";
    setFiles(next);
    setNeedsPassword(false);
    setPassword("");
    await loadPreview(next, format, "");
  }

  async function runImport() {
    setImporting(true);
    try {
      const { data } = await api.post<AppImportResult>("/app-import", body());
      setErrors(data.errors ?? []);
      toast.success(
        t("hosts.importSummary", {
          imported: data.success ?? 0,
          updated: data.updated ?? 0,
          failed: data.failed ?? 0,
        }),
      );
      onImported();
      if (!data.errors?.length) onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t("hosts.importHostsFailed")));
    } finally {
      setImporting(false);
    }
  }

  const missingUser =
    preview?.hosts.filter((h) => h.connectionType === "ssh" && !h.username)
      .length ?? 0;
  const canImport =
    !!preview &&
    preview.hosts.length > 0 &&
    (missingUser === 0 || defaultUsername.trim() !== "");

  const skipText = (entry: Preview["skipped"][number]) =>
    t(`appImport.skip.${entry.code}`, { detail: entry.detail ?? "" });

  return (
    <InlineView
      stacked
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<FileUp className="size-4" />}
      title={t("appImport.title")}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void runImport()}
          saving={importing}
          disabled={!canImport}
          saveLabel={
            preview
              ? t("appImport.importCount", { count: preview.hosts.length })
              : t("appImport.import")
          }
          cancelLabel={t("hosts.export.cancel")}
        />
      }
    >
      <SectionCard title={t("appImport.source")} icon={<FileUp />}>
        <div className="flex flex-col gap-3 py-2">
          <SelectField
            label={t("appImport.app")}
            value={format}
            onChange={(value) => {
              const next = value as AppFormat | "auto";
              setFormat(next);
              void loadPreview(files, next);
            }}
            options={[
              { value: "auto", label: t("appImport.apps.auto") },
              ...APP_FORMATS.map((value) => ({
                value,
                label: t(`appImport.apps.${value}`),
              })),
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {t(`appImport.hints.${format}`)}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => fileInput.current?.click()}>
              <FileUp className="size-3.5" />
              {t("appImport.pickFiles")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => folderInput.current?.click()}
            >
              <FolderOpen className="size-3.5" />
              {t("appImport.pickFolder")}
            </Button>
            {files.length > 0 && (
              <span className="text-xs text-muted-foreground truncate">
                {files.length === 1
                  ? files[0].name
                  : t("appImport.filesPicked", { count: files.length })}
              </span>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".csv,.mxtsessions,.mobaconf,.ini,.reg,.xml,.txt"
            className="hidden"
            onChange={(e) => void pick(e)}
          />
          <input
            ref={folderInput}
            type="file"
            className="hidden"
            {...({ webkitdirectory: "" } as object)}
            onChange={(e) => void pick(e)}
          />
          {needsPassword && (
            <div className="flex items-end gap-2">
              <div className="flex-1 flex flex-col gap-1">
                <label
                  className="text-sm font-medium"
                  htmlFor="app-import-password"
                >
                  {t("appImport.masterPassword")}
                </label>
                <Input
                  id="app-import-password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("appImport.masterPasswordHint")}
                </p>
              </div>
              <Button
                size="sm"
                disabled={!password}
                onClick={() => void loadPreview(files)}
              >
                {t("appImport.unlock")}
              </Button>
            </div>
          )}
        </div>
      </SectionCard>

      {loading && <LoadingState compact />}

      {preview && (
        <SectionCard
          title={t("appImport.found", {
            count: preview.hosts.length,
            app: t(`appImport.apps.${preview.format}`),
          })}
          icon={<Server />}
        >
          <div className="flex flex-col gap-3 py-2">
            {missingUser > 0 && (
              <TextField
                label={t("appImport.defaultUsername")}
                hint={t("appImport.defaultUsernameHint", {
                  count: missingUser,
                })}
                value={defaultUsername}
                placeholder="root"
                onChange={setDefaultUsername}
              />
            )}
            <SwitchRow
              label={t("appImport.overwrite")}
              description={t("appImport.overwriteHint")}
              checked={overwrite}
              onChange={setOverwrite}
            />
            <PanelList
              empty={
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {t("hosts.importNoHosts")}
                </p>
              }
            >
              {preview.hosts.map((host, index) => (
                <ListRow
                  key={`${host.folder.join("/")}/${host.name}/${index}`}
                  stripe={index}
                  icon={
                    host.connectionType === "rdp" ||
                    host.connectionType === "vnc" ? (
                      <Monitor className="size-3.5" />
                    ) : (
                      <Server className="size-3.5" />
                    )
                  }
                  title={host.name}
                  meta={[
                    `${host.username ? `${host.username}@` : ""}${host.ip}:${host.port}`,
                    host.connectionType.toUpperCase(),
                    host.folder.join(" / "),
                    host.hasPassword ? t("appImport.withPassword") : "",
                  ]
                    .filter(Boolean)
                    .join(" | ")}
                />
              ))}
            </PanelList>
          </div>
        </SectionCard>
      )}

      {preview && preview.skipped.length > 0 && (
        <SectionCard
          title={t("appImport.notImported", { count: preview.skipped.length })}
          icon={<TriangleAlert />}
        >
          <PanelList>
            {preview.skipped.map((entry, index) => (
              <ListRow
                key={`${entry.name}/${index}`}
                stripe={index}
                title={entry.name}
                meta={skipText(entry)}
              />
            ))}
          </PanelList>
        </SectionCard>
      )}

      {errors.length > 0 && (
        <SectionCard
          title={t("appImport.errors", { count: errors.length })}
          icon={<TriangleAlert />}
        >
          <ul className="py-2 text-xs text-destructive flex flex-col gap-1">
            {errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </SectionCard>
      )}
    </InlineView>
  );
}
