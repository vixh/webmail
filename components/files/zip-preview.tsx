"use client";

import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import { Download, Eye, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

interface ZipEntryView {
  name: string;
  directory: boolean;
  size: number | null;
}

export interface ZipEntryPreview {
  name: string;
  getFileContent: () => Promise<{ blob: Blob; contentType: string }>;
}

interface ZipPreviewProps {
  blob: Blob;
  onPreviewEntry: (entry: ZipEntryPreview) => void;
}

function formatBytes(value: number | null): string {
  if (value === null) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function displayName(path: string): string {
  return path.split("/").filter(Boolean).pop() || "archive-file";
}

export function ZipPreview({ blob, onPreviewEntry }: ZipPreviewProps) {
  const [entries, setEntries] = useState<ZipEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zip, setZip] = useState<JSZip | null>(null);
  const [busyEntry, setBusyEntry] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    setZip(null);

    if (blob.size > MAX_ARCHIVE_BYTES) {
      setError("Archive is too large for an in-browser preview (100 MB maximum).");
      return () => { cancelled = true; };
    }

    void JSZip.loadAsync(blob, { createFolders: true, checkCRC32: false })
      .then((loadedZip) => {
        if (cancelled) return;
        const values = Object.values(loadedZip.files);
        if (values.length > MAX_ENTRIES) {
          setError(`Archive contains too many entries (${values.length}; maximum ${MAX_ENTRIES}).`);
          return;
        }
        const mapped = values.map((entry) => {
          const internal = entry as typeof entry & { _data?: { uncompressedSize?: number } };
          return {
            name: entry.name,
            directory: entry.dir,
            size: entry.dir || typeof internal._data?.uncompressedSize !== "number"
              ? null
              : internal._data.uncompressedSize,
          };
        });
        mapped.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
        setZip(loadedZip);
        setEntries(mapped);
      })
      .catch(() => {
        if (!cancelled) setError("The ZIP archive is damaged, encrypted, or uses an unsupported format.");
      });

    return () => { cancelled = true; };
  }, [blob]);

  async function extract(entry: ZipEntryView): Promise<Blob> {
    if (!zip || entry.directory) throw new Error("Archive entry is unavailable.");
    if (entry.size !== null && entry.size > MAX_ENTRY_BYTES) {
      throw new Error("Archive entry is too large for an in-browser preview.");
    }
    const file = zip.file(entry.name);
    if (!file) throw new Error("Archive entry is unavailable.");
    const extracted = await file.async("blob");
    if (extracted.size > MAX_ENTRY_BYTES) {
      throw new Error("Archive entry is too large for an in-browser preview.");
    }
    return extracted;
  }

  function preview(entry: ZipEntryView) {
    onPreviewEntry({
      name: displayName(entry.name),
      getFileContent: async () => ({ blob: await extract(entry), contentType: "" }),
    });
  }

  async function download(entry: ZipEntryView) {
    setBusyEntry(entry.name);
    setError(null);
    try {
      const extracted = await extract(entry);
      const url = URL.createObjectURL(extracted);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = displayName(entry.name);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("This file could not be extracted from the archive.");
    } finally {
      setBusyEntry(null);
    }
  }

  const summary = useMemo(() => {
    if (!entries) return null;
    const files = entries.filter((entry) => !entry.directory);
    const folders = entries.length - files.length;
    const total = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    return `${files.length} files, ${folders} folders${total ? `, ${formatBytes(total)}` : ""}`;
  }, [entries]);

  if (error) {
    return <div className="rounded-lg bg-background p-6 text-sm text-destructive">{error}</div>;
  }
  if (!entries) {
    return <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />;
  }

  return (
    <div
      className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-background text-foreground"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="border-b border-border px-4 py-3 text-sm text-muted-foreground">{summary}</div>
      <div className="min-h-0 flex-1 overflow-auto">
        {entries.map((entry) => (
          <div key={entry.name} className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-sm last:border-b-0">
            <span aria-hidden="true" className="shrink-0">{entry.directory ? "📁" : "📄"}</span>
            <span className="min-w-0 flex-1 truncate" title={entry.name}>{entry.name}</span>
            {!entry.directory && <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(entry.size)}</span>}
            {!entry.directory && (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title="Preview"
                  aria-label={`Preview ${entry.name}`}
                  onClick={() => preview(entry)}
                >
                  <Eye className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title="Download"
                  aria-label={`Download ${entry.name}`}
                  disabled={busyEntry === entry.name}
                  onClick={() => void download(entry)}
                >
                  {busyEntry === entry.name
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Download className="h-4 w-4" />}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
