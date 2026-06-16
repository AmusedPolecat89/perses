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

interface WhitePersesLogoProps {
  title?: string;
}

function WhitePersesLogo(props: WhitePersesLogoProps): ReactElement {
  const { title = 'OBSESC Logo' } = props;
  // Asset is black-on-transparent; invert to white for the dark header.
  return (
    <img
      src={markSrc}
      alt={title}
      height={32}
      style={{ filter: 'invert(1)', display: 'block', objectFit: 'contain' }}
    />
  );
}

export default WhitePersesLogo;
