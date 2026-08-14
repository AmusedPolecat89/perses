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

import shared from '../jest.shared';

export default {
  ...shared,
  moduleNameMapper: {
    // OBSESC fork: this ui/ workspace ships `app`, `core` and
    // `internal-utils` only — the rest of @perses-dev/* is consumed from
    // node_modules as published packages. The shared config maps every
    // @perses-dev/* import onto a sibling SOURCE folder that therefore does
    // not exist here, so any test whose component tree touches one (e.g.
    // `useLocalStorage` from @perses-dev/components, which the onboarding
    // banner reads) failed to resolve rather than failing to pass. This entry
    // is FIRST because jest applies moduleNameMapper in insertion order.
    '^@perses-dev/(components|dashboards|explore|plugin-system)$': '<rootDir>/../node_modules/@perses-dev/$1',
    ...shared.moduleNameMapper,
  },
};
