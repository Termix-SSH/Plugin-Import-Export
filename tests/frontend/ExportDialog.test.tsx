import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import type { SSHHostWithStatus } from "@termix-ssh/plugin-sdk/ui";

const api = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const merged: Record<string, unknown> = { ...original };
  const factories: Array<
    (importOriginal: <T = Record<string, unknown>>() => Promise<T>) => unknown
  > = [
    () => ({
      usePluginStore: () => ({
        loaded: true,
        settled: true,
        records: new Map([
          [
            "remote-desktop",
            {
              frontend: "active",
              summary: {
                id: "remote-desktop",
                contributes: {
                  settings: {
                    host: {
                      fields: [
                        {
                          key: "guacamoleConfig",
                          secretKeys: ["gateway-password"],
                        },
                      ],
                    },
                  },
                },
              },
            },
          ],
        ]),
      }),
    }),
  ];
  for (const factory of factories) {
    Object.assign(
      merged,
      await factory((async () => ({ ...merged })) as never),
    );
  }
  return merged;
});

// The remote-desktop plugin declares its gateway password as a secret key.
const i18n = vi.hoisted(() => ({
  t: (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key,
}));

vi.mock("react-i18next", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const merged: Record<string, unknown> = { ...original };
  const factories: Array<
    (importOriginal: <T = Record<string, unknown>>() => Promise<T>) => unknown
  > = [
    () => ({
      useTranslation: () => i18n,
    }),
  ];
  for (const factory of factories) {
    Object.assign(
      merged,
      await factory((async () => ({ ...merged })) as never),
    );
  }
  return merged;
});
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const merged: Record<string, unknown> = { ...original };
  const factories: Array<
    (importOriginal: <T = Record<string, unknown>>() => Promise<T>) => unknown
  > = [
    () => ({
      useTranslation: () => i18n,
    }),
  ];
  for (const factory of factories) {
    Object.assign(
      merged,
      await factory((async () => ({ ...merged })) as never),
    );
  }
  return merged;
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ExportDialog } from "../../src/frontend/ExportDialog";

function sshHost(
  overrides: Partial<SSHHostWithStatus> = {},
): SSHHostWithStatus {
  return {
    id: 1,
    name: "web",
    ip: "10.0.0.1",
    port: 22,
    username: "deploy",
    folder: "",
    tags: [],
    pin: false,
    authType: "password",
    connectionType: "ssh",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "online",
    ...overrides,
  };
}

function rawPayload() {
  return {
    hosts: [
      {
        connectionType: "ssh",
        name: "web",
        ip: "10.0.0.1",
        port: 22,
        username: "deploy",
        password: "hunter2",
        pluginSettings: {
          "remote-desktop": {
            guacamoleConfig: {
              "gateway-hostname": "gw.example.com",
              "gateway-password": "gw-secret",
            },
          },
        },
      },
    ],
  };
}

function checkboxFor(labelKey: string): HTMLElement {
  const label = screen.getByText(labelKey).closest("label");
  if (!label) throw new Error(`no label wrapping ${labelKey}`);
  const checkbox = label.querySelector('[role="checkbox"]');
  if (!checkbox) throw new Error(`no checkbox inside ${labelKey}`);
  return checkbox as HTMLElement;
}

beforeEach(() => {
  api.get.mockReset();
  api.get.mockResolvedValue({ data: rawPayload() });
});

afterEach(() => {
  cleanup();
});

describe("ExportDialog - credential handling", () => {
  it("calls the masked export endpoint by default on open", async () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        hosts={[sshHost()]}
        api={api as never}
      />,
    );

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledTimes(1);
    });
    expect(api.get).toHaveBeenCalledWith("/export", {
      params: { share: "1" },
    });
  });

  it("calls the full export endpoint after the credentials checkbox is toggled", async () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        hosts={[sshHost()]}
        api={api as never}
      />,
    );

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(checkboxFor("hosts.export.groupCredentials"));

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledTimes(2);
    });
    expect(api.get).toHaveBeenNthCalledWith(1, "/export", {
      params: { share: "1" },
    });
    expect(api.get).toHaveBeenNthCalledWith(2, "/export", {});
  });

  it("masks the secret in the preview but includes it in the exported file", async () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        hosts={[sshHost()]}
        api={api as never}
      />,
    );

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(checkboxFor("hosts.export.groupCredentials"));

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(document.querySelector("pre")?.textContent).toContain(
        "<included>",
      );
    });
    expect(document.querySelector("pre")?.textContent).not.toContain("hunter2");

    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      capturedBlob = blob as Blob;
      return "blob:mock";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const exportButton = screen
      .getByText("hosts.export.confirm")
      .closest("button")!;
    await waitFor(() =>
      expect((exportButton as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(exportButton);

    await waitFor(() => expect(capturedBlob).toBeDefined());
    const text = await capturedBlob!.text();
    expect(text).toContain("hunter2");
    expect(text).not.toContain("<included>");
  });

  it("omits the nested guacamole secret from the exported file when credentials are excluded", async () => {
    render(
      <ExportDialog
        open
        onClose={() => {}}
        hosts={[sshHost()]}
        api={api as never}
      />,
    );

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(document.querySelector("pre")?.textContent).toContain(
        "gateway-hostname",
      );
    });

    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      capturedBlob = blob as Blob;
      return "blob:mock";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const exportButton = screen
      .getByText("hosts.export.confirm")
      .closest("button")!;
    await waitFor(() =>
      expect((exportButton as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(exportButton);

    await waitFor(() => expect(capturedBlob).toBeDefined());
    const text = await capturedBlob!.text();
    expect(text).not.toContain("gw-secret");
    expect(text).toContain("gw.example.com");

    const parsed = JSON.parse(text);
    expect(
      parsed.hosts[0].pluginSettings["remote-desktop"].guacamoleConfig[
        "gateway-password"
      ],
    ).toBeNull();
  });
});
