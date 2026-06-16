// Copyright OBSESC Authors
//
// Onboarding state machine — backed by localStorage so the banner
// stays dismissed across sessions and the header indicator clears
// once the operator marks first-event complete.

import { useLocalStorage } from '@perses-dev/components';
import { useNodeStats } from '../cluster/use-node-stats';

const COMPLETE_KEY = 'PERSES_OBSESC_ONBOARDED';
const BANNER_DISMISSED_KEY = 'PERSES_OBSESC_ONBOARDING_BANNER_DISMISSED';

export interface OnboardedState {
  // True once the operator has either (a) sent a first event so
  // ingest crossed zero or (b) explicitly clicked "mark complete"
  // on the onboarding page.
  isComplete: boolean;
  // True only if `isComplete` is false AND the operator hasn't
  // dismissed the banner — i.e. the visible banner predicate.
  bannerVisible: boolean;
  markComplete: () => void;
  reopenOnboarding: () => void;
  dismissBanner: () => void;
}

export function useOnboarded(): OnboardedState {
  const [storedComplete, setStoredComplete] = useLocalStorage<boolean>(COMPLETE_KEY, false);
  const [bannerDismissed, setBannerDismissed] = useLocalStorage<boolean>(
    BANNER_DISMISSED_KEY,
    false
  );
  const { data: stats } = useNodeStats(15_000);

  // Auto-complete the moment first ingest lands — operator shouldn't
  // need to click "I'm done" if the data itself proves they are.
  const ingestSeen = (stats?.totalIngestBytesCumulative ?? 0) > 0;
  const isComplete = storedComplete || ingestSeen;

  // Dev/demo override: setting localStorage.PERSES_OBSESC_FORCE_BANNER
  // to "true" forces the banner visible regardless of ingest state.
  // Useful for previewing the onboarding flow on a node that already
  // has data.
  const forceBanner =
    typeof window !== 'undefined' &&
    window.localStorage.getItem('PERSES_OBSESC_FORCE_BANNER') === 'true';

  return {
    isComplete: forceBanner ? false : isComplete,
    bannerVisible: forceBanner || (!isComplete && !bannerDismissed),
    markComplete: () => setStoredComplete(true),
    reopenOnboarding: () => {
      setStoredComplete(false);
      setBannerDismissed(false);
    },
    dismissBanner: () => setBannerDismissed(true),
  };
}
