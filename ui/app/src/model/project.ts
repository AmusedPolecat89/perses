// Copyright OBSESC Authors
//
// OBSESC is a single-project deployment. The slug is fixed (URL +
// resource references depend on it); only the display name is
// editable by the operator. Keeping the slug in one place means a
// future rename is a one-liner — change DEFAULT_PROJECT_SLUG and
// the provisioning YAML, and the rest of the app follows.

export const DEFAULT_PROJECT_SLUG = 'my-project';
export const DEFAULT_PROJECT_DISPLAY_NAME = 'My Project';
export const DEFAULT_PROJECT_DESCRIPTION = 'Operator dashboards for this OBSESC node.';

export const NODEHEALTH_DASHBOARD_NAME = 'nodehealth';
export const ANOMALIES_DASHBOARD_NAME = 'anomalies';

export function projectRoute(slug: string = DEFAULT_PROJECT_SLUG): string {
  return `/projects/${slug}`;
}

export function dashboardRoute(
  dashboardName: string,
  slug: string = DEFAULT_PROJECT_SLUG
): string {
  return `/projects/${slug}/dashboards/${dashboardName}`;
}
