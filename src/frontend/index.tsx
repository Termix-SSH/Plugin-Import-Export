import { useEffect, useState, type ComponentType } from "react";
import { CloudUpload, Download, FileUp, Upload } from "lucide-react";
import {
  notifyHostsChanged,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { getSSHHosts, type SSHHostWithStatus } from "@termix-ssh/plugin-sdk/ui";
import { AppImportView } from "./AppImportView";
import { BackupView } from "./BackupView";
import { ExportDialog } from "./ExportDialog";
import { FileImportView } from "./FileImportView";

type View =
  | { type: "json"; overwrite: boolean }
  | { type: "ssh" }
  | { type: "app" }
  | { type: "export"; hostIds: string[] }
  | { type: "backup" };

export function activate(app: TermixApp): void {
  // Actions and the overlay both run in the plugin's background frame, so
  // the menu reaches the views through this.
  let current: View | null = null;
  const listeners = new Set<(view: View | null) => void>();
  const show = (view: View | null) => {
    current = view;
    for (const listener of listeners) listener(view);
  };

  function ImportExportOverlay() {
    const [view, setView] = useState<View | null>(current);
    const [hosts, setHosts] = useState<SSHHostWithStatus[]>([]);

    useEffect(() => {
      listeners.add(setView);
      return () => {
        listeners.delete(setView);
      };
    }, []);

    useEffect(() => {
      if (view?.type !== "export") return;
      let live = true;
      void getSSHHosts().then((list) => {
        if (live) setHosts(list);
      });
      return () => {
        live = false;
      };
    }, [view]);

    if (!view) return null;
    // The shell only shows the overlay frame while it sees a dialog or this
    // marker; an InlineView draws into the scope's layer and has neither.
    return (
      <>
        <span data-overlay="" hidden />
        <OverlayView view={view} hosts={hosts} />
      </>
    );
  }

  function OverlayView({
    view,
    hosts,
  }: {
    view: View;
    hosts: SSHHostWithStatus[];
  }) {
    const close = () => show(null);
    const changed = () => notifyHostsChanged();

    switch (view.type) {
      case "json":
      case "ssh":
        return (
          <FileImportView
            api={app.api}
            kind={view.type}
            overwrite={view.type === "json" && view.overwrite}
            onClose={close}
            onImported={changed}
          />
        );
      case "app":
        return (
          <AppImportView api={app.api} onClose={close} onImported={changed} />
        );
      case "backup":
        return (
          <BackupView api={app.api} onClose={close} onRestored={changed} />
        );
      case "export":
        return (
          <ExportDialog
            open
            onClose={close}
            hosts={hosts}
            preselectedHostIds={new Set(view.hostIds)}
            api={app.api}
          />
        );
    }
  }

  app.registerSlotContribution("shell.overlay", {
    actionId: "import-export.overlay",
    titleKey: "hosts.importExportBtn",
    kind: "component",
    component: ImportExportOverlay as ComponentType<Record<string, unknown>>,
  });

  // Actions carry the permission, so the menu hides everything from users
  // who may not use the plugin.
  const gate = { permission: "use" };
  const items: Array<{
    id: string;
    titleKey: string;
    icon: typeof Upload;
    view: () => View;
  }> = [
    {
      id: "import-export.importJson",
      titleKey: "hosts.importSkipExisting",
      icon: Upload,
      view: () => ({ type: "json", overwrite: false }),
    },
    {
      id: "import-export.importJsonOverwrite",
      titleKey: "hosts.importOverwrite",
      icon: Upload,
      view: () => ({ type: "json", overwrite: true }),
    },
    {
      id: "import-export.importSshConfig",
      titleKey: "hosts.importSSHConfig",
      icon: Upload,
      view: () => ({ type: "ssh" }),
    },
    {
      id: "import-export.importApp",
      titleKey: "appImport.menuItem",
      icon: FileUp,
      view: () => ({ type: "app" }),
    },
    {
      id: "import-export.export",
      titleKey: "hosts.export.menuItem",
      icon: Download,
      view: () => ({ type: "export", hostIds: [] }),
    },
    {
      id: "import-export.backup",
      titleKey: "backup.menuItem",
      icon: CloudUpload,
      view: () => ({ type: "backup" }),
    },
  ];
  items.forEach((item, index) => {
    app.registerAction(item.id, () => show(item.view()), gate);
    app.registerSlotContribution("hosts.importMenu", {
      actionId: item.id,
      titleKey: item.titleKey,
      icon: item.icon as never,
      kind: "button",
      order: index,
    });
  });

  app.registerAction(
    "import-export.exportSelected",
    (hostIds: string[]) => {
      show({
        type: "export",
        hostIds: Array.isArray(hostIds) ? hostIds.map(String) : [],
      });
    },
    gate,
  );
  app.registerSlotContribution("hosts.selectionActions", {
    actionId: "import-export.exportSelected",
    titleKey: "hosts.export.bulkButton",
    icon: Download as never,
  });
}
