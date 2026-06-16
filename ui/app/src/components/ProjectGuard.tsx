// Copyright OBSESC Authors
//
// Wraps the / redirect. Ensures the default project exists before
// redirecting into a dashboard URL that assumes it. Recovery path
// for "operator deleted the project from the UI" — without this,
// they'd hit a 404 cascade and need to restart the perses
// container to get provisioning to re-seed.
//
// Lifecycle:
//   1. Fetch /api/v1/projects.
//   2. If the default slug is present → redirect to NodeHealth.
//   3. If absent → POST a fresh project with the default display
//      name, then redirect.
//   4. If the API itself is down → show a small fallback rather
//      than a blank screen.

import { ReactElement, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Box, CircularProgress, Typography } from '@mui/material';
import {
  DEFAULT_PROJECT_SLUG,
  DEFAULT_PROJECT_DISPLAY_NAME,
  DEFAULT_PROJECT_DESCRIPTION,
  NODEHEALTH_DASHBOARD_NAME,
  dashboardRoute,
} from '../model/project';

type GuardState =
  | { kind: 'checking' }
  | { kind: 'ready'; slug: string }
  | { kind: 'creating' }
  | { kind: 'error'; message: string };

async function listProjects(): Promise<Array<{ name: string }>> {
  const res = await fetch('/api/v1/projects');
  if (!res.ok) throw new Error(`projects list HTTP ${res.status}`);
  const body = (await res.json()) as Array<{ metadata?: { name?: string } }>;
  return body
    .map((p) => p.metadata?.name)
    .filter((n): n is string => typeof n === 'string')
    .map((name) => ({ name }));
}

async function createDefaultProject(): Promise<void> {
  const res = await fetch('/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'Project',
      metadata: { name: DEFAULT_PROJECT_SLUG },
      spec: {
        display: {
          name: DEFAULT_PROJECT_DISPLAY_NAME,
          description: DEFAULT_PROJECT_DESCRIPTION,
        },
      },
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`project create HTTP ${res.status}: ${await res.text()}`);
  }
}

export function ProjectGuard(): ReactElement {
  const [state, setState] = useState<GuardState>({ kind: 'checking' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let projects = await listProjects();
        if (projects.some((p) => p.name === DEFAULT_PROJECT_SLUG)) {
          if (!cancelled) setState({ kind: 'ready', slug: DEFAULT_PROJECT_SLUG });
          return;
        }
        // Default missing — recreate. Note: we always re-seed the
        // default slug, even if some other project exists, so the
        // logo + dashboard URLs stay stable.
        if (!cancelled) setState({ kind: 'creating' });
        await createDefaultProject();
        if (!cancelled) setState({ kind: 'ready', slug: DEFAULT_PROJECT_SLUG });
        // Re-list isn't required — POST returned 2xx so we know it's there.
        void projects;
      } catch (e) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'ready') {
    return <Navigate to={dashboardRoute(NODEHEALTH_DASHBOARD_NAME, state.slug)} replace />;
  }
  if (state.kind === 'error') {
    return (
      <Box sx={{ p: 4, maxWidth: 720, mx: 'auto' }}>
        <Alert severity="error" variant="outlined">
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Couldn't reach the API to bootstrap the project.
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {state.message}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            The Perses backend may be starting up. Reload in a moment.
          </Typography>
        </Alert>
      </Box>
    );
  }
  return (
    <Box sx={{ p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <CircularProgress size={28} />
      <Typography variant="body2" color="text.secondary">
        {state.kind === 'creating' ? 'Creating your project…' : 'Checking workspace…'}
      </Typography>
    </Box>
  );
}
