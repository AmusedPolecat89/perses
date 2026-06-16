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

import { ReactElement } from 'react';
import markSrc from '../../assets/obsesc/logo-mark.png';

interface PersesLogoCroppedProps {
  color?: string;
  width?: number;
  height?: number;
}

function PersesLogoCropped(props: PersesLogoCroppedProps): ReactElement {
  const { color, width = 120, height = 120 } = props;
  // Asset is black-on-transparent; invert when caller asks for white (dark header).
  const filter = color === 'white' ? 'invert(1)' : undefined;
  return (
    <img
      src={markSrc}
      alt="OBSESC"
      width={width}
      height={height}
      style={{ filter, display: 'block', objectFit: 'contain' }}
    />
  );
}

export default PersesLogoCropped;
