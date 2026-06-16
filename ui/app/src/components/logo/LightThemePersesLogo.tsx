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

function LightThemePersesLogo(): ReactElement {
  // Asset is black-on-transparent; render as-is on the light sign-in screen.
  return <img src={markSrc} alt="OBSESC" height={116} style={{ display: 'block', objectFit: 'contain' }} />;
}

export default LightThemePersesLogo;
