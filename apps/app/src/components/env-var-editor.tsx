"use client";

import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { type ClipboardEvent, useEffect, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hasPublicBuildEnvPrefix } from "@/lib/build-env";

interface EnvVar {
  key: string;
  value: string;
  buildTime?: boolean;
}

interface EnvVarEditorProps {
  value: EnvVar[];
  onChange: (vars: EnvVar[]) => void;
  managedKeys?: string[];
  onValidationChange?: (hasErrors: boolean) => void;
  managedKeySettingsUrl?: string;
}

function parseEnvContent(text: string): EnvVar[] {
  const results: EnvVar[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let val = trimmed.slice(eqIndex + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) results.push({ key, value: val });
  }
  return results;
}

const RESERVED_KEYS = ["PORT"];

const BUILD_TOGGLE_TITLE =
  "Available during docker build (as a build arg and in .env); will be visible in the image. Leave unchecked for secrets.";
const AUTO_BUILD_TITLE =
  "Public-prefixed variables are always available during docker build and will be visible in the image.";

export function EnvVarEditor({
  value,
  onChange,
  managedKeys = [],
  onValidationChange,
  managedKeySettingsUrl,
}: EnvVarEditorProps) {
  const baseId = useId();
  const reservedKeysUpper = new Set(
    [...RESERVED_KEYS, ...managedKeys].map((k) => k.toUpperCase()),
  );

  const hasErrors = value.some((v) =>
    reservedKeysUpper.has(v.key.toUpperCase()),
  );

  useEffect(() => {
    onValidationChange?.(hasErrors);
  }, [hasErrors, onValidationChange]);

  function handleAdd() {
    onChange([...value, { key: "", value: "" }]);
  }

  function handleRemove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function handleChange(index: number, field: "key" | "value", val: string) {
    const updated = [...value];
    updated[index] = { ...updated[index], [field]: val };
    onChange(updated);
  }

  function handleBuildTimeChange(index: number, checked: boolean) {
    const updated = [...value];
    const { buildTime: _buildTime, ...rest } = updated[index];
    updated[index] = checked ? { ...rest, buildTime: true } : rest;
    onChange(updated);
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>, index: number) {
    const text = e.clipboardData.getData("text");
    if (text.includes("=") && text.includes("\n")) {
      e.preventDefault();
      const parsed = parseEnvContent(text);
      if (parsed.length > 0) {
        const before = value.slice(0, index);
        const after = value.slice(index + 1);
        onChange([...before, ...parsed, ...after]);
      }
    }
  }

  return (
    <div className="space-y-3">
      {value.length > 0 && (
        <div className="flex gap-2 text-xs text-muted-foreground font-medium">
          <div className="flex-1">KEY</div>
          <div className="flex-1">VALUE</div>
          <div className="w-12 text-center" title={BUILD_TOGGLE_TITLE}>
            BUILD
          </div>
          <div className="w-9" />
        </div>
      )}
      {value.map((envVar, index) => {
        const id = `${baseId}-${index}`;
        const isReserved = reservedKeysUpper.has(envVar.key.toUpperCase());
        const isAutoBuildTime = hasPublicBuildEnvPrefix(envVar.key.trim());
        const buildLabel = envVar.key
          ? `Available during build: ${envVar.key}`
          : `Variable ${index + 1} available during build`;
        return (
          <div key={id} className="space-y-1">
            <div className="flex gap-2 group">
              <Input
                value={envVar.key}
                onChange={(e) => handleChange(index, "key", e.target.value)}
                onPaste={(e) => handlePaste(e, index)}
                aria-label={`Variable ${index + 1} key`}
                aria-invalid={isReserved || undefined}
                className={`flex-1 font-mono text-sm ${isReserved ? "border-red-500" : ""}`}
              />
              <Input
                value={envVar.value}
                onChange={(e) => handleChange(index, "value", e.target.value)}
                aria-label={
                  envVar.key
                    ? `Value for ${envVar.key}`
                    : `Variable ${index + 1} value`
                }
                className="flex-1 font-mono text-sm"
              />
              <label
                className="flex w-12 shrink-0 items-center justify-center"
                title={isAutoBuildTime ? AUTO_BUILD_TITLE : BUILD_TOGGLE_TITLE}
              >
                <input
                  type="checkbox"
                  checked={isAutoBuildTime || envVar.buildTime === true}
                  disabled={isAutoBuildTime}
                  onChange={(e) =>
                    handleBuildTimeChange(index, e.target.checked)
                  }
                  aria-label={buildLabel}
                  className="h-4 w-4 rounded border-neutral-700 bg-neutral-800 disabled:opacity-60"
                />
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="opacity-50 hover:opacity-100"
                onClick={() => handleRemove(index)}
                aria-label={
                  envVar.key
                    ? `Remove ${envVar.key}`
                    : `Remove variable ${index + 1}`
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {isReserved && (
              <p className="text-xs text-red-500">
                {envVar.key.toUpperCase()} is managed by{" "}
                {managedKeySettingsUrl ? (
                  <Link
                    href={managedKeySettingsUrl}
                    className="underline hover:text-red-400"
                  >
                    Container Port setting
                  </Link>
                ) : (
                  "Container Port setting"
                )}
              </p>
            )}
          </div>
        );
      })}
      {value.length > 0 && (
        <p className="text-xs text-muted-foreground">
          All variables are set at runtime. Only variables marked Build are
          passed to docker build, where they are visible in the image.
          Public-prefixed keys (NEXT_PUBLIC_, VITE_, PUBLIC_, ...) are always
          build-time.
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        onClick={handleAdd}
        className="h-8 px-2 text-muted-foreground"
      >
        <Plus className="h-4 w-4 mr-1" />
        Add
      </Button>
    </div>
  );
}
