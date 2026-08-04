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

package ui

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAssetHandlerContentType(t *testing.T) {
	// Override the package-level embedded filesystem with test data.
	originalAsts := asts
	t.Cleanup(func() { asts = originalAsts })

	testFS := fstest.MapFS{
		"app/dist/main.abc123.css": &fstest.MapFile{Data: []byte("body { color: red; }")},
		"app/dist/main.abc123.js":  &fstest.MapFile{Data: []byte("console.log('hello')")},
		"app/dist/image.png":       &fstest.MapFile{Data: []byte("fake-png-data")},
		"app/dist/index.html":      &fstest.MapFile{Data: []byte("<html></html>")},
	}
	asts = http.FS(testFS)

	f := &frontend{apiPrefix: ""}

	tests := []struct {
		name                 string
		path                 string
		expectedContentTypes []string
	}{
		{
			name:                 "CSS file",
			path:                 "/app/dist/main.abc123.css",
			expectedContentTypes: []string{"text/css; charset=utf-8"},
		},
		{
			name: "JavaScript file",
			path: "/app/dist/main.abc123.js",
			// Windows registers the obsolete application/javascript MIME type.
			expectedContentTypes: []string{"text/javascript; charset=utf-8", "application/javascript"},
		},
		{
			name:                 "HTML file",
			path:                 "/app/dist/index.html",
			expectedContentTypes: []string{"text/html; charset=utf-8"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := echo.New()
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			rec := httptest.NewRecorder()
			ctx := e.NewContext(req, rec)

			handler := f.assetHandler()
			err := handler(ctx)
			require.NoError(t, err)
			assert.Contains(t, tt.expectedContentTypes, rec.Header().Get("Content-Type"))
			assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
		})
	}
}

func TestServeASTFilesContentType(t *testing.T) {
	// Override the package-level embedded filesystem with test data.
	originalAsts := asts
	t.Cleanup(func() { asts = originalAsts })

	testFS := fstest.MapFS{
		"app/dist/index.html": &fstest.MapFile{Data: []byte("<html><head></head><body></body></html>")},
	}
	asts = http.FS(testFS)

	f := &frontend{apiPrefix: ""}

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	ctx := e.NewContext(req, rec)

	err := f.serveASTFiles(ctx)
	require.NoError(t, err)
	assert.Equal(t, "text/html; charset=utf-8", rec.Header().Get("Content-Type"))
	assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
}

func TestRouterMiddlewareSpaFallback(t *testing.T) {
	// Override the package-level embedded filesystem with test data.
	originalAsts := asts
	t.Cleanup(func() { asts = originalAsts })

	testFS := fstest.MapFS{
		"app/dist/index.html":     &fstest.MapFile{Data: []byte("<html><head></head><body></body></html>")},
		"app/dist/main.abc123.js": &fstest.MapFile{Data: []byte("console.log('hello')")},
	}
	asts = http.FS(testFS)

	// Every OBSESC route plus the upstream /explore precedent must serve
	// index.html on direct load (the SPA fallback); asset paths and unknown
	// paths must fall through to next() so assetHandler / the 404 path
	// handles them.
	spaRoutes := []string{
		"/alerts",
		"/cluster",
		"/onboarding",
		"/explore",
		"/foresight",
		"/investigate",
		"/integrity",
	}
	for _, route := range spaRoutes {
		t.Run("serves index for "+route, func(t *testing.T) {
			f := &frontend{apiPrefix: ""}
			e := echo.New()
			req := httptest.NewRequest(http.MethodGet, route, nil)
			rec := httptest.NewRecorder()
			ctx := e.NewContext(req, rec)

			nextCalled := false
			next := func(echo.Context) error {
				nextCalled = true
				return nil
			}
			err := f.routerMiddleware()(next)(ctx)
			require.NoError(t, err)
			assert.False(t, nextCalled, "SPA route must not fall through to the asset handler")
			assert.Equal(t, http.StatusOK, rec.Code)
			assert.Equal(t, "text/html; charset=utf-8", rec.Header().Get("Content-Type"))
			assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
		})
	}

	for _, path := range []string{"/app/dist/main.abc123.js", "/definitely-not-a-route"} {
		t.Run("falls through for "+path, func(t *testing.T) {
			f := &frontend{apiPrefix: ""}
			e := echo.New()
			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			ctx := e.NewContext(req, rec)

			nextCalled := false
			next := func(echo.Context) error {
				nextCalled = true
				return nil
			}
			err := f.routerMiddleware()(next)(ctx)
			require.NoError(t, err)
			assert.True(t, nextCalled, "non-route path must fall through to next()")
		})
	}

	t.Run("apiPrefix joins the route prefix", func(t *testing.T) {
		f := &frontend{apiPrefix: "/perses"}
		e := echo.New()

		// The prefixed path serves index.html…
		req := httptest.NewRequest(http.MethodGet, "/perses/investigate", nil)
		rec := httptest.NewRecorder()
		ctx := e.NewContext(req, rec)
		nextCalled := false
		next := func(echo.Context) error {
			nextCalled = true
			return nil
		}
		err := f.routerMiddleware()(next)(ctx)
		require.NoError(t, err)
		assert.False(t, nextCalled)
		assert.Equal(t, "text/html; charset=utf-8", rec.Header().Get("Content-Type"))

		// …while the bare path falls through.
		req = httptest.NewRequest(http.MethodGet, "/investigate", nil)
		rec = httptest.NewRecorder()
		ctx = e.NewContext(req, rec)
		nextCalled = false
		err = f.routerMiddleware()(next)(ctx)
		require.NoError(t, err)
		assert.True(t, nextCalled, "un-prefixed path must not match when apiPrefix is set")
	})
}
