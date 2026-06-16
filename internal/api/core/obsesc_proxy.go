// Copyright OBSESC Authors
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

package core

import (
	"net/url"
	"os"

	"github.com/labstack/echo/v4"
	echoMiddleware "github.com/labstack/echo/v4/middleware"
	"github.com/sirupsen/logrus"
)

// obsescAPIProxy serves the co-located obsesc-node query API under
// /obsesc-api/* — the same contract the rspack dev server provides via
// its proxy, so app code (NodeManager stats, onboarding ingest probe)
// works identically in dev and in the AMI (readiness run #12, finding
// #9: the hardcoded /obsesc-api path 404'd in production, killing
// Cluster stats and showing the onboarding banner over live data).
//
// Target defaults to the in-AMI co-located node; OBSESC_API_URL
// overrides for split-role topologies (https targets verify against
// the system trust store — the AMI installs the node cert there).
//
// Readiness run #13 finding #2: with the node's bearer auth on, the
// proxy must authenticate or every co-located UI consumer gets 401.
// OBSESC_API_TOKEN (injected by CFN UserData from Secrets Manager,
// same source as the node's query_api_token) is attached as the
// Authorization header on every proxied request. Browser sessions
// never see the token — it lives server-side in the proxy.
type obsescAPIProxy struct {
	target *url.URL
	token  string
}

func newObsescAPIProxy() *obsescAPIProxy {
	raw := os.Getenv("OBSESC_API_URL")
	if raw == "" {
		raw = "http://127.0.0.1:18080"
	}
	target, err := url.Parse(raw)
	if err != nil {
		logrus.WithError(err).Errorf("obsesc-api proxy: invalid OBSESC_API_URL %q; falling back to default", raw)
		target, _ = url.Parse("http://127.0.0.1:18080")
	}
	token := os.Getenv("OBSESC_API_TOKEN")
	if token == "" {
		logrus.Warn("obsesc-api proxy: OBSESC_API_TOKEN unset; proxied requests are unauthenticated (dev mode)")
	}
	return &obsescAPIProxy{target: target, token: token}
}

func (p *obsescAPIProxy) RegisterRoute(e *echo.Echo) {
	group := e.Group("/obsesc-api")
	if p.token != "" {
		bearer := "Bearer " + p.token
		group.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
			return func(c echo.Context) error {
				// Replace, never forward, any client-supplied value.
				c.Request().Header.Set("Authorization", bearer)
				return next(c)
			}
		})
	}
	group.Use(echoMiddleware.ProxyWithConfig(echoMiddleware.ProxyConfig{
		Balancer: echoMiddleware.NewRoundRobinBalancer([]*echoMiddleware.ProxyTarget{
			{URL: p.target},
		}),
		Rewrite: map[string]string{
			"/obsesc-api/*": "/$1",
		},
	}))
}
