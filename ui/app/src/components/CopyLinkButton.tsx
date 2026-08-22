// Copyright OBSESC Authors
//
// B3.5 — the permalink affordance. The investigation's whole state (time
// range via use-time-range-url, per-view inputs via use-url-backed-state)
// lives in the URL, so "share this" is exactly `location.href`. This button
// is the affordance that says so — without it nobody discovers that the
// address bar became the investigation.

import { ReactElement, useEffect, useRef, useState } from 'react';
import { Button, Tooltip } from '@mui/material';
import LinkVariant from 'mdi-material-ui/LinkVariant';
import Check from 'mdi-material-ui/Check';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path (clipboard API needs a secure
    // context; a plain-HTTP node UI does not have one).
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copies the current `location.href`. The label flips to "Copied" for a
 * moment — the visible label changes so a screen reader announces it, and
 * tests hold on to the stable `data-testid`.
 */
export function CopyLinkButton(): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  return (
    <Tooltip title="The URL holds this page's inputs and time range — copy it to share or bookmark the investigation.">
      <Button
        size="small"
        variant="outlined"
        data-testid="copy-permalink-btn"
        startIcon={copied ? <Check /> : <LinkVariant />}
        onClick={() => {
          void copyText(window.location.href).then((ok) => {
            if (!ok) return;
            setCopied(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </Button>
    </Tooltip>
  );
}
