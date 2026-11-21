import { useCallback, useEffect, useState } from "react";
import { ArchiveRestore, CloudUpload, FileArchive } from "lucide-react";
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
  NumberField,
  PanelList,
  SectionCard,
  SelectField,
  SwitchRow,
  TextField,
  getErrorMessage,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";

type Schedule = "off" | "daily" | "weekly";

interface Config {
  accountId: number;
  bucket: string;
  prefix: string;
  schedule: Schedule;
  hour: number;
  keep: number;
  hasPassphrase: boolean;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | null;
  lastError: string | null;
  nextRunAt: string | null;
}

interface State {
  available: boolean;
  config: Config | null;
  accounts: Array<{ id: number; name: string }>;
}

interface BackupFile {
  key: string;
  size: number;
  modifiedAt: string | null;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "";

/** Backs the user's hosts up to a bucket on a schedule, and restores them. */
export function BackupView({
  api,
  onClose,
  onRestored,
}: {
  api: PluginApiClient;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [state, setState] = useState<State | null>(null);
  const [buckets, setBuckets] = useState<string[]>([]);
  const [accountId, setAccountId] = useState(0);
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("termix");
  const [schedule, setSchedule] = useState<Schedule>("daily");
  const [hour, setHour] = useState(3);
  const [keep, setKeep] = useState(14);
  const [passphrase, setPassphrase] = useState("");
  const [files, setFiles] = useState<BackupFile[] | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const loadFiles = useCallback(async () => {
    try {
      setFiles(
        (await api.get<{ files: BackupFile[] }>("/backup/files")).data.files,
      );
    } catch {
      setFiles([]);
    }
  }, [api]);

  const load = useCallback(async () => {
    const { data } = await api.get<State>("/backup");
    setState(data);
    if (data.config) {
      setAccountId(data.config.accountId);
      setBucket(data.config.bucket);
      setPrefix(data.config.prefix.replace(/\/$/, ""));
      setSchedule(data.config.schedule);
      setHour(data.config.hour);
      setKeep(data.config.keep);
      void loadFiles();
    } else if (data.accounts[0]) {
      setAccountId(data.accounts[0].id);
    }
  }, [api, loadFiles]);

  useEffect(() => {
    void load().catch((e) =>
      toast.error(getErrorMessage(e, t("backup.loadFailed"))),
    );
  }, [load, t]);

  useEffect(() => {
    if (!accountId) return;
    void api
      .get<{ buckets: string[] }>(`/backup/buckets?accountId=${accountId}`)
      .then(({ data }) => setBuckets(data.buckets))
      .catch(() => setBuckets([]));
  }, [api, accountId]);

  const config = state?.config ?? null;
  const canSave =
    accountId > 0 &&
    !!bucket &&
    (passphrase.length >= 8 || (!!config?.hasPassphrase && !passphrase)) &&
    !saving;

  async function save() {
    setSaving(true);
    try {
      await api.put("/backup", {
        accountId,
        bucket,
        prefix,
        schedule,
        hour,
        keep,
        passphrase,
      });
      setPassphrase("");
      toast.success(t("backup.saved"));
      await load();
    } catch (e) {
      toast.error(getErrorMessage(e, t("backup.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const { data } = await api.post<{ hosts: number }>("/backup/run");
      toast.success(t("backup.done", { count: data.hosts }));
      await load();
    } catch (e) {
      toast.error(getErrorMessage(e, t("backup.runFailed")));
    } finally {
      setRunning(false);
    }
  }

  async function restore(file: BackupFile) {
    const ok = await confirm({
      title: t("backup.restoreTitle"),
      description: t(
        overwrite ? "backup.restoreDescOverwrite" : "backup.restoreDesc",
        { when: when(file.modifiedAt) || file.key },
      ),
      confirmLabel: t("backup.restore"),
    });
    if (!ok) return;
    try {
      const { data } = await api.post<{
        success: number;
        updated: number;
        failed: number;
      }>("/backup/restore", { key: file.key, overwrite });
      toast.success(
        t("backup.restored", {
          added: data.success,
          updated: data.updated,
          failed: data.failed,
        }),
      );
      onRestored();
    } catch (e) {
      toast.error(getErrorMessage(e, t("backup.restoreFailed")));
    }
  }

  return (
    <InlineView
      stacked
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<CloudUpload className="size-4" />}
      title={t("backup.title")}
      status={
        config?.lastRunAt
          ? t(
              config.lastStatus === "failed"
                ? "backup.lastFailed"
                : "backup.lastGood",
              { when: when(config.lastRunAt) },
            )
          : undefined
      }
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void save()}
          saving={saving}
          disabled={!canSave}
          saveLabel={t("backup.save")}
          cancelLabel={t("backup.close")}
        />
      }
    >
      {!state ? (
        <LoadingState compact />
      ) : !state.available ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">
          {t("backup.needsStorage")}
        </p>
      ) : state.accounts.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">
          {t("backup.noAccounts")}
        </p>
      ) : (
        <>
          <SectionCard title={t("backup.where")} icon={<CloudUpload />}>
            <div className="flex flex-col gap-3 py-2">
              <SelectField
                label={t("backup.account")}
                value={accountId ? String(accountId) : ""}
                onChange={(value) => {
                  setAccountId(Number(value));
                  setBucket("");
                }}
                options={state.accounts.map((a) => ({
                  value: String(a.id),
                  label: a.name,
                }))}
              />
              <SelectField
                label={t("backup.bucket")}
                value={bucket}
                placeholder={t("backup.pickBucket")}
                onChange={setBucket}
                options={buckets.map((name) => ({ value: name, label: name }))}
              />
              <TextField
                label={t("backup.folder")}
                value={prefix}
                placeholder="termix"
                onChange={setPrefix}
              />
            </div>
          </SectionCard>

          <SectionCard title={t("backup.when")} icon={<FileArchive />}>
            <div className="flex flex-col gap-3 py-2">
              <SelectField
                label={t("backup.schedule")}
                value={schedule}
                onChange={(value) => setSchedule(value as Schedule)}
                options={[
                  { value: "off", label: t("backup.scheduleOff") },
                  { value: "daily", label: t("backup.scheduleDaily") },
                  { value: "weekly", label: t("backup.scheduleWeekly") },
                ]}
              />
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <NumberField
                  label={t("backup.hour")}
                  hint={t("backup.hourHint")}
                  value={hour}
                  min={0}
                  max={23}
                  disabled={schedule === "off"}
                  onChange={(value) =>
                    setHour(Math.min(23, Math.max(0, Math.floor(value) || 0)))
                  }
                />
                <NumberField
                  label={t("backup.keep")}
                  value={keep}
                  min={1}
                  max={365}
                  onChange={(value) =>
                    setKeep(Math.min(365, Math.max(1, Math.floor(value) || 1)))
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium" htmlFor="backup-pass">
                  {t("backup.passphrase")}
                </label>
                <Input
                  id="backup-pass"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  placeholder={
                    config?.hasPassphrase ? t("backup.passphraseKept") : ""
                  }
                  onChange={(e) => setPassphrase(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("backup.passphraseHint")}
                </p>
              </div>
              {config?.lastError && (
                <p className="text-xs text-destructive">{config.lastError}</p>
              )}
            </div>
          </SectionCard>

          {config && (
            <SectionCard title={t("backup.files")} icon={<ArchiveRestore />}>
              <div className="flex flex-col gap-2 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={running}
                    onClick={() => void runNow()}
                  >
                    <CloudUpload className="size-3.5" />
                    {running ? t("backup.running") : t("backup.runNow")}
                  </Button>
                </div>
                <SwitchRow
                  label={t("backup.overwrite")}
                  description={t("backup.overwriteHint")}
                  checked={overwrite}
                  onChange={setOverwrite}
                />
                {!files ? (
                  <LoadingState compact />
                ) : (
                  <PanelList
                    empty={
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        {t("backup.noFiles")}
                      </p>
                    }
                  >
                    {files.map((file, index) => (
                      <ListRow
                        key={file.key}
                        stripe={index}
                        icon={<FileArchive className="size-3.5" />}
                        title={when(file.modifiedAt) || file.key}
                        meta={file.key}
                        trailing={
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => void restore(file)}
                          >
                            {t("backup.restore")}
                          </Button>
                        }
                      />
                    ))}
                  </PanelList>
                )}
              </div>
            </SectionCard>
          )}
        </>
      )}
    </InlineView>
  );
}
