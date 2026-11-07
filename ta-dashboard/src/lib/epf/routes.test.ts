import { describe, expect, test } from "bun:test";

import {
    CONFIG_TABS,
    EPF_ROOT,
    EPF_TABS,
    configHref,
    configTabForPath,
    epfHref,
    epfIndexRedirectTarget,
    epfTabForPath,
    isConfigTab
} from "./routes.ts";

describe("epfHref", () => {
    test("returns the route of every tab", () => {
        expect(epfHref("source")).toBe("/apps/epf/source");
        expect(epfHref("config")).toBe("/apps/epf/config");
        expect(epfHref("console")).toBe("/apps/epf/console");
        expect(epfHref("outputs")).toBe("/apps/epf/outputs");
    });

    test("matches the hrefs published for navigation", () => {
        for (const tab of EPF_TABS) {
            expect(tab.href).toBe(epfHref(tab.id));
        }
    });
});

describe("configHref", () => {
    test("defaults to the editor", () => {
        expect(configHref()).toBe("/apps/epf/config/editor");
        expect(configHref("editor")).toBe("/apps/epf/config/editor");
    });

    test("points at every sub-route", () => {
        expect(configHref("library")).toBe("/apps/epf/config/library");
        expect(configHref("environment")).toBe("/apps/epf/config/environment");
        expect(configHref("storage")).toBe("/apps/epf/config/storage");
    });

    test("matches the hrefs published for the section navigation", () => {
        for (const tab of CONFIG_TABS) {
            expect(tab.href).toBe(configHref(tab.id));
        }
    });
});

describe("epfTabForPath", () => {
    test("resolves every tab", () => {
        expect(epfTabForPath("/apps/epf/source")).toBe("source");
        expect(epfTabForPath("/apps/epf/config")).toBe("config");
        expect(epfTabForPath("/apps/epf/console")).toBe("console");
        expect(epfTabForPath("/apps/epf/outputs")).toBe("outputs");
    });

    test("keeps the tab active on a nested route", () => {
        expect(epfTabForPath("/apps/epf/config/editor")).toBe("config");
        expect(epfTabForPath("/apps/epf/config/storage")).toBe("config");
        expect(epfTabForPath("/apps/epf/source/extra")).toBe("source");
    });

    test("treats the app root as Source", () => {
        expect(epfTabForPath(EPF_ROOT)).toBe("source");
    });

    test("normalises a trailing slash", () => {
        expect(epfTabForPath("/apps/epf/config/")).toBe("config");
        expect(epfTabForPath("/apps/epf/config/editor/")).toBe("config");
    });

    test("ignores paths outside the app or with an unknown first segment", () => {
        expect(epfTabForPath("/apps/epf/unknown")).toBeNull();
        expect(epfTabForPath("/apps/epf/configx")).toBeNull();
        expect(epfTabForPath("/tools/results-viewer")).toBeNull();
        expect(epfTabForPath("/")).toBeNull();
    });
});

describe("configTabForPath", () => {
    test("resolves every sub-route", () => {
        expect(configTabForPath("/apps/epf/config/editor")).toBe("editor");
        expect(configTabForPath("/apps/epf/config/library")).toBe("library");
        expect(configTabForPath("/apps/epf/config/environment")).toBe("environment");
        expect(configTabForPath("/apps/epf/config/storage")).toBe("storage");
        expect(configTabForPath("/apps/epf/config/storage/")).toBe("storage");
    });

    test("rejects the config root and other paths", () => {
        expect(configTabForPath("/apps/epf/config")).toBeNull();
        expect(configTabForPath("/apps/epf/config/unknown")).toBeNull();
        expect(configTabForPath("/apps/epf/source")).toBeNull();
    });

    test("recognises section names", () => {
        expect(isConfigTab("storage")).toBe(true);
        expect(isConfigTab("nope")).toBe(false);
        expect(isConfigTab(null)).toBe(false);
        expect(isConfigTab(undefined)).toBe(false);
    });
});

describe("epfIndexRedirectTarget", () => {
    test("points at Source", () => {
        expect(epfIndexRedirectTarget({ search: "", hash: "" })).toBe("/apps/epf/source");
    });

    test("keeps search and hash so shared links survive the redirect", () => {
        expect(
            epfIndexRedirectTarget({
                search: "?config=x",
                hash: "#?EPF_CONFIG_URL=https%3A%2F%2Fexample.com%2Fepf.toml"
            })
        ).toBe("/apps/epf/source?config=x#?EPF_CONFIG_URL=https%3A%2F%2Fexample.com%2Fepf.toml");
    });
});
