// Copyright OBSESC Authors
// Licensed under proprietary terms; see project root LICENSE.

import { Box, Theme } from '@mui/material';
import { SxProps } from '@mui/system/styleFunctionSx/styleFunctionSx';
import { ReactElement } from 'react';

const style: SxProps<Theme> = {
  display: 'flex',
  flexDirection: 'row',
  justifyContent: 'center',
  alignItems: 'center',
  fontSize: '0.75rem',
  letterSpacing: '0.25em',
  opacity: 0.5,
  textTransform: 'lowercase',
  padding: '8px 0',
};

export default function Footer(): ReactElement {
  return (
    <Box component="footer" sx={style}>
      obsesc
    </Box>
  );
}
