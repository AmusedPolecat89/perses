// Copyright OBSESC Authors
//
// Editable display-name card. Lives on the Cluster page since
// "what this deployment is called" sits with other deployment-level
// metadata. URL slug stays fixed (DEFAULT_PROJECT_SLUG); only the
// display name and description are editable — Perses' provisioning
// only seeds the initial values, so operator edits persist.

import { ReactElement, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PROJECT_DESCRIPTION,
  DEFAULT_PROJECT_DISPLAY_NAME,
  DEFAULT_PROJECT_SLUG,
} from '../../model/project';

// Perses' YAML provisioning re-applies on every backend restart and
// always create-or-updates, which clobbers operator edits. We store
// the operator's chosen display name in localStorage and reconcile
// the backend back to it whenever there's a mismatch — restart-safe.
const LS_DISPLAY_NAME = 'OBSESC_PROJECT_DISPLAY_NAME';
const LS_DESCRIPTION = 'OBSESC_PROJECT_DESCRIPTION';

interface ProjectResource {
  kind: 'Project';
  metadata: {
    name: string;
    createdAt?: string;
    updatedAt?: string;
    version?: number;
  };
  spec: {
    display?: {
      name?: string;
      description?: string;
    };
  };
}

async function fetchProject(slug: string): Promise<ProjectResource> {
  const res = await fetch(`/api/v1/projects/${slug}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ProjectResource;
}

async function putProject(project: ProjectResource): Promise<ProjectResource> {
  const res = await fetch(`/api/v1/projects/${project.metadata.name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(project),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ProjectResource;
}

export function ProjectSettings(): ReactElement {
  const slug = DEFAULT_PROJECT_SLUG;
  const queryClient = useQueryClient();

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['obsesc-project', slug],
    queryFn: () => fetchProject(slug),
  });

  const [displayName, setDisplayName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Hydrate the form: prefer the operator's saved choice (localStorage)
  // over whatever the backend currently has. If they're equal, no-op.
  useEffect(() => {
    if (!project) return;
    if (displayName !== '' || description !== '') return;
    const savedName = (typeof window !== 'undefined' && window.localStorage.getItem(LS_DISPLAY_NAME)) || '';
    const savedDesc = (typeof window !== 'undefined' && window.localStorage.getItem(LS_DESCRIPTION)) || '';
    setDisplayName(savedName || project.spec.display?.name || DEFAULT_PROJECT_DISPLAY_NAME);
    setDescription(savedDesc || project.spec.display?.description || DEFAULT_PROJECT_DESCRIPTION);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!project) throw new Error('project not loaded yet');
      const next: ProjectResource = {
        ...project,
        spec: {
          ...project.spec,
          display: {
            ...(project.spec.display ?? {}),
            name: displayName.trim() || DEFAULT_PROJECT_DISPLAY_NAME,
            description: description.trim(),
          },
        },
      };
      const result = await putProject(next);
      // Stick the operator's choice in localStorage so the reconciler
      // (below) can reapply it after a backend provisioning restart.
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LS_DISPLAY_NAME, next.spec.display?.name ?? '');
        window.localStorage.setItem(LS_DESCRIPTION, next.spec.display?.description ?? '');
      }
      return result;
    },
    onSuccess: () => {
      setSavedAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: ['obsesc-project', slug] });
    },
  });

  // Reconciler: if the backend drifted from the operator's saved
  // preference (typically because provisioning clobbered it on
  // restart), silently PUT the saved values back. Fires once per
  // project load.
  useEffect(() => {
    if (!project || typeof window === 'undefined') return;
    const savedName = window.localStorage.getItem(LS_DISPLAY_NAME);
    if (!savedName) return;
    const savedDesc = window.localStorage.getItem(LS_DESCRIPTION) ?? '';
    const backendName = project.spec.display?.name ?? '';
    const backendDesc = project.spec.display?.description ?? '';
    if (backendName === savedName && backendDesc === savedDesc) return;
    void putProject({
      ...project,
      spec: {
        ...project.spec,
        display: {
          ...(project.spec.display ?? {}),
          name: savedName,
          description: savedDesc,
        },
      },
    }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['obsesc-project', slug] });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const dirty =
    project !== undefined &&
    (displayName !== (project.spec.display?.name ?? '') ||
      description !== (project.spec.display?.description ?? ''));

  return (
    <Box
      sx={{
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'background.border',
        backgroundColor: 'background.paper',
        padding: 2.5,
        mt: 3,
      }}
    >
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        Project
      </Typography>
      <Typography variant="caption" color="text.secondary">
        How this deployment is labelled across the UI. URL slug stays{' '}
        <code style={{ fontFamily: '"JetBrains Mono", monospace' }}>{slug}</code>.
      </Typography>

      {isLoading && (
        <Box sx={{ mt: 2 }}>
          <CircularProgress size={18} />
        </Box>
      )}
      {error && (
        <Alert severity="error" variant="outlined" sx={{ mt: 2 }}>
          Couldn't load the project: {error instanceof Error ? error.message : String(error)}
        </Alert>
      )}

      {project && (
        <Stack gap={2} sx={{ mt: 2, maxWidth: 480 }}>
          <TextField
            label="Display name"
            size="small"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            helperText="Shown in the breadcrumb, project page, and dashboard list."
          />
          <TextField
            label="Description"
            size="small"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            multiline
            minRows={2}
          />
          <Stack direction="row" gap={1} alignItems="center">
            <Button
              variant="contained"
              disabled={!dirty || mutation.isLoading}
              onClick={() => mutation.mutate()}
            >
              {mutation.isLoading ? 'Saving…' : 'Save'}
            </Button>
            {mutation.error && (
              <Typography variant="caption" color="error.main">
                {mutation.error instanceof Error ? mutation.error.message : 'Save failed'}
              </Typography>
            )}
            {savedAt && !dirty && !mutation.error && (
              <Typography variant="caption" color="success.main">
                Saved.
              </Typography>
            )}
          </Stack>
        </Stack>
      )}
    </Box>
  );
}
