// Copyright The Perses Authors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Link as RouterLink } from 'react-router-dom';
import { AppBar, Badge, Box, Button, Toolbar } from '@mui/material';
import ServerNetwork from 'mdi-material-ui/ServerNetwork';
import RocketLaunchOutline from 'mdi-material-ui/RocketLaunchOutline';
import CompassOutline from 'mdi-material-ui/CompassOutline';
import CrystalBall from 'mdi-material-ui/CrystalBall';
import CompareHorizontal from 'mdi-material-ui/CompareHorizontal';
import ShieldCheckOutline from 'mdi-material-ui/ShieldCheckOutline';
import React from 'react';
import { useIsLaptopSize, useIsMobileSize } from '../../utils/browser-size';
import { useIsAuthEnabled } from '../../context/Config';
import { useOnboarded } from '../../views/onboarding/use-onboarded';
import { AlertsNavButton } from '../../views/alerts/AlertsNavButton';
import { projectRoute } from '../../model/project';
import WhitePersesLogo from '../logo/WhitePersesLogo';
import PersesLogoCropped from '../logo/PersesLogoCropped';
import { BannerInfo } from '../BannerInfo';
import { AccountMenu } from './AccountMenu';
import { SearchBar } from './SearchBar/SearchBar';

export default function Header(): JSX.Element {
  const isLaptopSize = useIsLaptopSize();
  const isMobileSize = useIsMobileSize();
  const isAuthEnabled = useIsAuthEnabled();
  const { isComplete: onboardingComplete } = useOnboarded();

  return (
    // U14: `position="relative"` scrolled the whole nav out of reach on any
    // route tall enough for the DOCUMENT to scroll — which on a dashboard is
    // every route, because the dashboard grid grows the page rather than
    // scrolling inside itself. Crossing from a dashboard to another section
    // then needed a scroll-to-top or a URL edit. Sticky pins it identically
    // on every route; `top: 0` and the appBar z-index keep it above the
    // dashboard's own sticky variable row.
    <AppBar position="sticky" sx={{ top: 0, zIndex: (theme) => theme.zIndex.appBar }}>
      <Toolbar
        sx={{
          backgroundColor: (theme) => theme.palette.background.navigation,
          // The header is always rendered on the dark ink surface — even
          // in light mode. Force text + icons to paper-white so the brand
          // mark, search, and account menu stay readable.
          color: (theme) => theme.palette.text.navigation,
          '&': {
            minHeight: '40px',
            paddingLeft: 0,
            paddingRight: 0.75,
          },
        }}
      >
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            width: '100%',
            flexShrink: isMobileSize ? 2 : 1,
          }}
        >
          <Button
            component={RouterLink}
            to={projectRoute()}
            sx={{
              padding: 0,
            }}
            aria-label="Project dashboards"
          >
            {isLaptopSize ? <WhitePersesLogo /> : <PersesLogoCropped color="white" width={32} height={32} />}
          </Button>
          {/* OBSESC β.3.1: Admin / Config / Explore nav stripped — the
              brief calls for a single-operator surface with no plugin
              catalog / datasource manager visible. Theme toggle hidden
              so dark default holds without a tempting one-click switch.
              Cluster is the one operational surface we keep, since
              vertical scaling is the headline ops action. */}
          {!isMobileSize && (
            <>
              <Button
                aria-label="Onboarding"
                color="inherit"
                component={RouterLink}
                to="/onboarding"
                sx={{ marginLeft: 1 }}
              >
                <Badge
                  color="primary"
                  variant="dot"
                  invisible={onboardingComplete}
                  sx={{ marginRight: 0.5 }}
                >
                  <RocketLaunchOutline fontSize="small" />
                </Badge>
                <Box sx={{ marginLeft: 0.5 }}>Onboarding</Box>
              </Button>
              <Button
                aria-label="Cluster"
                color="inherit"
                component={RouterLink}
                to="/cluster"
                sx={{ marginLeft: 0.5 }}
              >
                <ServerNetwork sx={{ marginRight: 0.5 }} fontSize="small" /> Cluster
              </Button>
              <Button
                aria-label="Explore"
                color="inherit"
                component={RouterLink}
                to="/explore"
                sx={{ marginLeft: 0.5 }}
              >
                <CompassOutline sx={{ marginRight: 0.5 }} fontSize="small" /> Explore
              </Button>
              <AlertsNavButton />
              <Button
                aria-label="Foresight"
                color="inherit"
                component={RouterLink}
                to="/foresight"
                sx={{ marginLeft: 0.5 }}
              >
                <CrystalBall sx={{ marginRight: 0.5 }} fontSize="small" /> Foresight
              </Button>
              {/* OBSESC Lane U3: diff-vs-baseline forensics */}
              <Button
                aria-label="Investigate"
                color="inherit"
                component={RouterLink}
                to="/investigate"
                sx={{ marginLeft: 0.5 }}
              >
                <CompareHorizontal sx={{ marginRight: 0.5 }} fontSize="small" /> Investigate
              </Button>
              {/* OBSESC Lane U6: custody-chain verification */}
              <Button
                aria-label="Integrity"
                color="inherit"
                component={RouterLink}
                to="/integrity"
                sx={{ marginLeft: 0.5 }}
              >
                <ShieldCheckOutline sx={{ marginRight: 0.5 }} fontSize="small" /> Integrity
              </Button>
            </>
          )}
        </Box>
        <SearchBar />
        <Box
          sx={{
            width: '100%',
            flexShrink: isMobileSize ? 2 : 1,
            display: 'flex',
            justifyContent: 'end',
          }}
        >
          {isAuthEnabled && <AccountMenu />}
        </Box>
      </Toolbar>
      <BannerInfo />
    </AppBar>
  );
}
