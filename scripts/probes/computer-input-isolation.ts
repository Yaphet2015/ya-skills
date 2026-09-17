// Read-only input-isolation contract probe.
//
// This script reads the checked-in SDK contract/evidence and the product
// adapter source. It never imports @trycua/cua-driver, starts a driver,
// launches a fixture, opens a window, sends mouse/keyboard input, or listens
// for desktop events. Run it explicitly when an audit report is needed:
//
//   bun scripts/probes/computer-input-isolation.ts
//
// A finding with status "unsupported" is an observed capability gap. A
// finding with status "unknown" means that the local evidence is unavailable
// or changed. Neither status is a claim about an unobserved user's desktop.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type Status = "observed" | "unsupported" | "unknown";

type Finding = {
  status: Status;
  detail: string;
  evidence?: string[];
  values?: Record<string, unknown>;
};

type Report = {
  probe: "computer-input-isolation";
  mode: "read-only";
  driverStarted: false;
  desktopInputSent: false;
  generatedAt: string;
  checks: {
    sdkInputPolicy: Finding;
    savedContract: Finding;
    productAdapter: Finding;
    nativeRoute: Finding;
    fixtureSurface: Finding;
    userDesktopNoninterference: Finding;
  };
  conclusion: {
    inputIsolation: Status;
    userDesktopNoninterference: Status;
    detail: string;
  };
};

const repoRoot = resolve(import.meta.dir, "../..");
const sdkRoot = resolve(
  process.env.YA_INPUT_ISOLATION_SDK_DIR ??
    join(repoRoot, "packages/computer-runtime/node_modules/@trycua/cua-driver")
);
const sdkContractPath = join(sdkRoot, "dist/native/cua_driver_contract.d.ts");
const sdkReadmePath = join(sdkRoot, "README.md");
const backendPath = join(repoRoot, "packages/computer-runtime/src/cua-backend.ts");
const runtimeTypesPath = join(repoRoot, "packages/computer-runtime/src/types.ts");
const sessionPath = join(repoRoot, "packages/computer-runtime/src/session.ts");
const rawTypePath = join(
  repoRoot,
  "docs/verification/evidence/2026-09-16-native/type-diagnostic/raw-type.json"
);
const contractEvidencePath = join(
  repoRoot,
  "docs/verification/evidence/2026-09-16-native/type-diagnostic/input-isolation-contract.json"
);
const candidateEvidencePath = join(
  repoRoot,
  "docs/verification/evidence/2026-09-16-native/type-diagnostic/input-isolation-candidates.json"
);
const snapshotPath =
  process.env.YA_INPUT_ISOLATION_TOOLS_JSON ?? "/tmp/ya-input-contract/tools.json";
const currentFixturePaths = [
  join(repoRoot, "scripts/probes/fixtures/computer-use-native.swift"),
  join(repoRoot, "scripts/probes/fixtures/computer-use-ax-form.swift")
];
const historicalFixturePaths = [
  join(repoRoot, "docs/verification/evidence/2026-09-16-native/NonKeyFixture.swift")
];

function displayPath(path: string): string {
  return relative(repoRoot, path) || ".";
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(path: string): unknown {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function section(source: string, marker: RegExp): string | undefined {
  return source.match(marker)?.[0];
}

function hasAny(source: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(source));
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function inspectSdkPolicy(): Finding {
  const contract = readText(sdkContractPath);
  const readme = readText(sdkReadmePath);
  if (contract === undefined || readme === undefined) {
    const missing = [
      contract === undefined ? displayPath(sdkContractPath) : undefined,
      readme === undefined ? displayPath(sdkReadmePath) : undefined
    ].filter((path): path is string => path !== undefined);
    return {
      status: "unknown",
      detail: "SDK contract or README is unavailable; the input policy cannot be checked.",
      evidence: missing
    };
  }

  const click = section(contract, /export type ClickInput = \{[\s\S]*?\n\};/);
  const typeText = section(contract, /export type TypeTextInput = \{[\s\S]*?\n\};/);
  const pressKey = section(contract, /export type PressKeyInput = \{[\s\S]*?\n\};/);
  if (click === undefined || typeText === undefined || pressKey === undefined) {
    return {
      status: "unknown",
      detail: "The expected SDK input declarations were not found.",
      evidence: [displayPath(sdkContractPath)]
    };
  }

  const clickHasDeliveryMode = /deliveryMode\s*:\s*InputDeliveryMode/.test(click);
  const typeHasDeliveryMode = /deliveryMode\s*:/.test(typeText);
  const keyHasDeliveryMode = /deliveryMode\s*:/.test(pressKey);
  const readmeDescribesFallback = /AXSetAttribute|CGEvent|fallback|synthetic/i.test(readme);
  const strictAxOnlyControl = hasAny(typeText + "\n" + pressKey + "\n" + readme, [
    /ax[_ -]?only/i,
    /accessibility[_ -]?only/i,
    /no[_ -]?fallback/i,
    /strict(?:ly)?[_ -]?accessibility/i
  ]);

  const values = {
    clickHasDeliveryMode,
    typeHasDeliveryMode,
    keyHasDeliveryMode,
    readmeDescribesFallback,
    strictAxOnlyControl
  };

  if (clickHasDeliveryMode && !typeHasDeliveryMode && !keyHasDeliveryMode && !strictAxOnlyControl) {
    return {
      status: "unsupported",
      detail:
        "The installed SDK exposes background/foreground delivery for click, but no strict AX-only or no-fallback control for type_text or press_key.",
      evidence: [displayPath(sdkContractPath), displayPath(sdkReadmePath)],
      values
    };
  }

  return {
    status: "observed",
    detail:
      "The SDK declarations changed from the known 0.27 shape; inspect the route policy before treating it as an isolation guarantee.",
    evidence: [displayPath(sdkContractPath), displayPath(sdkReadmePath)],
    values
  };
}

function inspectSavedContract(): Finding {
  const evidence = readJson(contractEvidencePath);
  if (!isRecord(evidence)) {
    return {
      status: "unknown",
      detail: "The saved listToolsJson contract evidence is missing or invalid.",
      evidence: [displayPath(contractEvidencePath)]
    };
  }

  const source = jsonObject(evidence.source);
  const tools = arrayValue(evidence.tools);
  const typeText = tools?.find(
    (tool): tool is Record<string, unknown> =>
      isRecord(tool) && tool.name === "type_text"
  );
  const pressKey = tools?.find(
    (tool): tool is Record<string, unknown> =>
      isRecord(tool) && tool.name === "press_key"
  );
  if (typeText === undefined || pressKey === undefined) {
    return {
      status: "unknown",
      detail: "The saved contract has no complete type_text/press_key entries.",
      evidence: [displayPath(contractEvidencePath)]
    };
  }

  const typeDescription = textValue(typeText.description) ?? "";
  const pressDescription = textValue(pressKey.description) ?? "";
  const typeInput = jsonObject(typeText.input);
  const typeProperties = jsonObject(typeInput?.properties);
  const deliveryMode = jsonObject(typeProperties?.delivery_mode);
  const typeOutput = jsonObject(typeText.output);
  const route = jsonObject(typeOutput?.route);
  const fallbackText =
    /CGEvent|synthetic|fallback/i.test(typeDescription) &&
    /automatic|falls back|fallback/i.test(typeDescription);
  const deliveryModes = arrayValue(deliveryMode?.enum)?.filter(
    (value): value is string => typeof value === "string"
  );
  const routes = arrayValue(route?.enum)?.filter(
    (value): value is string => typeof value === "string"
  );

  return {
    status: "observed",
    detail:
      "The saved SDK tool contract records synthetic fallback language and a route enum that includes synthetic_events.",
    evidence: [displayPath(contractEvidencePath)],
    values: {
      sdk: textValue(source?.sdk),
      version: textValue(source?.version),
      method: textValue(source?.method),
      typeTextMentionsAutomaticSyntheticFallback: fallbackText,
      pressKeyMentionsBackgroundDelivery: /background/i.test(pressDescription),
      typeTextDeliveryModes: deliveryModes,
      typeTextRoutes: routes,
      snapshotPath: textValue(source?.snapshot) ?? snapshotPath,
      snapshotPresent: existsSync(snapshotPath),
      candidateEvidencePresent: existsSync(candidateEvidencePath)
    }
  };
}

function inspectProductAdapter(): Finding {
  const backend = readText(backendPath);
  const runtimeTypes = readText(runtimeTypesPath);
  const session = readText(sessionPath);
  if (backend === undefined || runtimeTypes === undefined || session === undefined) {
    const missing = [
      backend === undefined ? displayPath(backendPath) : undefined,
      runtimeTypes === undefined ? displayPath(runtimeTypesPath) : undefined,
      session === undefined ? displayPath(sessionPath) : undefined
    ].filter((path): path is string => path !== undefined);
    return {
      status: "unknown",
      detail: "The product adapter sources are unavailable; the adapter seam cannot be checked.",
      evidence: missing
    };
  }

  const typeAdapter = section(backend, /async type\(target[\s\S]*?(?=\n\s*async key\()/);
  const keyAdapter = section(backend, /async key\(target[\s\S]*?(?=\n\s*async scroll\()/);
  const clickBackgroundCount = (
    backend.match(/deliveryMode:\s*sdk\.InputDeliveryMode\.Background/g) ?? []
  ).length;
  const typeUsesFactory = /sdk\.TypeTextInput\.new/.test(typeAdapter ?? "");
  const keyUsesFactory = /sdk\.PressKeyInput\.new/.test(keyAdapter ?? "");
  const typeChoosesRoute = /deliveryMode|route|accessibility[_ -]?only|ax[_ -]?only/i.test(
    typeAdapter ?? ""
  );
  const keyChoosesRoute = /deliveryMode|route|accessibility[_ -]?only|ax[_ -]?only/i.test(
    keyAdapter ?? ""
  );
  const facade = section(runtimeTypes, /export interface Computer \{[\s\S]*?\n\}/);
  const resultShape = section(runtimeTypes, /export interface ToolResultLike \{[\s\S]*?\n\}/);
  const action = section(session, /private async action\([\s\S]*?(?=\n\s*private async ensureLease)/);
  const resultMetadataDropped =
    resultShape !== undefined &&
    !/\broute\b/.test(resultShape) &&
    !/\beffect\b/.test(resultShape) &&
    action !== undefined &&
    !/\bresult\.(?:route|effect|delivery)\b/.test(action);
  const mutationReturnsVoid =
    facade !== undefined &&
    /type\(target: Target, text: string\): Promise<void>/.test(facade) &&
    /key\(target: Target, key: string, modifiers\?: string\[\]\): Promise<void>/.test(facade);

  if (
    clickBackgroundCount >= 1 &&
    typeUsesFactory &&
    keyUsesFactory &&
    !typeChoosesRoute &&
    !keyChoosesRoute &&
    mutationReturnsVoid
  ) {
    return {
      status: "unsupported",
      detail:
        "The product adapter still constructs type/key through SDK factories without an AX-only/no-fallback route. The separate strict set_value seam does not make generic type/key safe.",
      evidence: [displayPath(backendPath), displayPath(runtimeTypesPath), displayPath(sessionPath)],
      values: {
        clickBackgroundCount,
        typeUsesFactory,
        keyUsesFactory,
        typeChoosesRoute,
        keyChoosesRoute,
        mutationReturnsVoid,
        resultMetadataDropped
      }
    };
  }

  return {
    status: "unknown",
    detail:
      "The adapter source changed from the audited shape; inspect dispatch policy and result handling before claiming isolation.",
    evidence: [displayPath(backendPath), displayPath(runtimeTypesPath), displayPath(sessionPath)],
    values: {
      clickBackgroundCount,
      typeUsesFactory,
      keyUsesFactory,
      typeChoosesRoute,
      keyChoosesRoute,
      mutationReturnsVoid,
      resultMetadataDropped
    }
  };
}

function actionRouteName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === 0) return "accessibility";
  if (value === 1) return "synthetic_events";
  if (value === 2) return "global_input";
  if (value === 3) return "system_api";
  if (value === 4) return "dom";
  if (value === 5) return "trusted_input";
  return undefined;
}

function deliveryModeName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === 0) return "background";
  if (value === 1) return "foreground";
  return undefined;
}

function effectName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === 0) return "confirmed";
  if (value === 1) return "partial";
  if (value === 2) return "unverifiable";
  if (value === 3) return "suspected_noop";
  if (value === 4) return "refused";
  return undefined;
}

function escalationTargetName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === 0) return "pixel";
  if (value === 1) return "foreground";
  if (value === 2) return "page";
  if (value === 3) return "session";
  return undefined;
}

function escalationReasonName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === 0) return "route_unavailable";
  if (value === 1) return "delivery_failed";
  if (value === 2) return "effect_unconfirmed";
  if (value === 3) return "suspected_noop";
  if (value === 4) return "permission_required";
  return undefined;
}

function inspectNativeRoute(): Finding {
  const raw = readJson(rawTypePath);
  if (!isRecord(raw)) {
    return {
      status: "unknown",
      detail: "The saved native type result is missing or invalid; no route was observed by this probe.",
      evidence: [displayPath(rawTypePath)]
    };
  }

  const result = jsonObject(raw.result);
  const action = jsonObject(result?.action);
  const structuredText = textValue(result?.structuredJson);
  const structured = structuredText === undefined ? undefined : readJsonFromText(structuredText);
  const structuredObject = jsonObject(structured);
  const delivery = jsonObject(action?.delivery);
  const escalation = jsonObject(action?.escalation);
  const route = actionRouteName(action?.route) ?? textValue(structuredObject?.route);
  const mode =
    deliveryModeName(delivery?.mode) ??
    textValue(jsonObject(structuredObject?.delivery)?.mode);
  const effect = effectName(action?.effect) ?? textValue(structuredObject?.effect);

  if (route === undefined || mode === undefined || effect === undefined) {
    return {
      status: "unknown",
      detail: "The saved native result has no complete route/effect/delivery classification.",
      evidence: [displayPath(rawTypePath)]
    };
  }

  return {
    status: "observed",
    detail:
      "The saved native type result reports a synthetic event route in Background mode with an unverifiable effect; its delivery result cannot be reclassified after dispatch.",
    evidence: [displayPath(rawTypePath)],
    values: {
      route,
      mode,
      effect,
      escalation: {
        target: escalationTargetName(escalation?.target) ?? escalation?.target,
        reason: escalationReasonName(escalation?.reason) ?? escalation?.reason
      },
      isError: result?.isError
    }
  };
}

function readJsonFromText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function inspectOneFixture(path: string, historical: boolean) {
    const source = readText(path);
    if (source === undefined) {
      return {
        path: displayPath(path),
        status: "unknown" as Status,
        historical,
        nonKeyPanel: false,
        ordersFrontRegardless: false,
        ordersBack: false,
        ignoresMouseEvents: false,
        ignoresMouseEventsByDefault: false,
        pointerOptIn: false,
        independentDesktopGuard: false,
        guardedFrontOrder: false
      };
    }

    const nonKeyPanel = /class\s+NonKeyPanel[\s\S]*?canBecomeKey\s*:\s*Bool\s*\{\s*false[\s\S]*?canBecomeMain\s*:\s*Bool\s*\{\s*false/.test(
      source
    );
    const ordersFrontRegardless = /orderFrontRegardless\s*\(\s*\)/.test(source);
    const ordersBack = /panel\.orderBack\s*\(\s*nil\s*\)/.test(source);
    const ignoresMouseEvents = /ignoresMouseEvents\s*=\s*true/.test(source);
    const ignoresMouseEventsByDefault = /ignoresMouseEvents\s*=\s*!\s*allowPointer/.test(source);
    const pointerOptIn = /--allow-pointer/.test(source);
    const independentDesktopGuard = /YK_INPUT_TEST_DESKTOP/.test(source) &&
      /environment\[\"YK_INPUT_TEST_DESKTOP\"\]\s*==\s*\"1\"/.test(source);
    const guardedFrontOrder = /if\s+allowPointer\s*\{[\s\S]{0,240}?orderFrontRegardless\s*\(\s*\)/.test(source);
    const currentFixtureSafe =
      (ignoresMouseEvents && ordersBack) ||
      (ignoresMouseEventsByDefault && ordersBack && pointerOptIn && independentDesktopGuard && guardedFrontOrder);
    // Historical evidence is retained for context, but it must not keep the
    // repaired current fixtures red. A historical unsafe panel is reported in
    // values below and never participates in the current status calculation.
    const status: Status = historical
      ? nonKeyPanel && ordersFrontRegardless && !ignoresMouseEvents ? "unsupported" : "observed"
      : currentFixtureSafe ? "observed" : "unsupported";
    return {
      path: displayPath(path),
      status,
      historical,
      nonKeyPanel,
      ordersFrontRegardless,
      ordersBack,
      ignoresMouseEvents,
      ignoresMouseEventsByDefault,
      pointerOptIn,
      independentDesktopGuard,
      guardedFrontOrder
    };
}

function inspectFixtureSurface(): Finding {
  const currentFixtures = currentFixturePaths.map((path) => inspectOneFixture(path, false));
  const historicalFixtures = historicalFixturePaths.map((path) => inspectOneFixture(path, true));

  const gap = currentFixtures.filter((finding) => finding.status === "unsupported");
  if (gap.length > 0) {
    return {
      status: "unsupported",
      detail:
        "A current input-test fixture is missing the default click-through/order-back guard. A normal NSPanel can therefore remain a possible physical mouse recipient; unchanged frontmost/key flags do not rule out intercepted clicks. This is a static fixture gap, not proof of the user's reported root cause.",
      evidence: gap.map((finding) => finding.path),
      values: {
        fixtures: currentFixtures,
        historicalFixtures,
        historicalFixturesDoNotAffectStatus: true,
        mitigation:
          "Current fixtures default to ignoresMouseEvents=true and orderBack(nil). Coordinate-input tests require --allow-pointer plus YK_INPUT_TEST_DESKTOP=1 on an independent test desktop."
      }
    };
  }

  return {
    status: currentFixtures.some((finding) => finding.status === "unknown") ? "unknown" : "observed",
    detail:
      "Current input-test fixtures default to click-through/order-back. The coordinate fixture enables pointer delivery only with --allow-pointer and YK_INPUT_TEST_DESKTOP=1; historical fixture findings are retained separately.",
    evidence: currentFixtures.map((finding) => finding.path),
    values: {
      fixtures: currentFixtures,
      historicalFixtures,
      historicalFixturesDoNotAffectStatus: true,
      coordinateInputGate: {
        flag: "--allow-pointer",
        environment: "YK_INPUT_TEST_DESKTOP=1",
        requirement: "independent test desktop"
      }
    }
  };
}

function buildReport(): Report {
  const sdkInputPolicy = inspectSdkPolicy();
  const savedContract = inspectSavedContract();
  const productAdapter = inspectProductAdapter();
  const nativeRoute = inspectNativeRoute();
  const fixtureSurface = inspectFixtureSurface();
  const userDesktopNoninterference: Finding = {
    status: "unknown",
    detail:
      "This report performs no desktop action and has no observation of the user's input consumers; noninterference remains unknown.",
    evidence: [
      displayPath(rawTypePath),
      "No new desktop run was performed by this probe."
    ]
  };

  const inputIsolation: Status =
    sdkInputPolicy.status === "unsupported" ||
    productAdapter.status === "unsupported" ||
    fixtureSurface.status === "unsupported"
      ? "unsupported"
      : "unknown";

  return {
    probe: "computer-input-isolation",
    mode: "read-only",
    driverStarted: false,
    desktopInputSent: false,
    generatedAt: new Date().toISOString(),
    checks: {
      sdkInputPolicy,
      savedContract,
      productAdapter,
      nativeRoute,
      fixtureSurface,
      userDesktopNoninterference
    },
    conclusion: {
      inputIsolation,
      userDesktopNoninterference: "unknown",
      detail:
        "A non-Accessibility route observed after dispatch cannot be changed into not_delivered. Isolation requires a strict AX-only/pre-dispatch policy or an independent test desktop."
    }
  };
}

function usage(): string {
  return [
    "computer-input-isolation (read-only contract/evidence probe)",
    "  no flags     print the report; no driver or desktop input is used",
    "  --help       print this help"
  ].join("\n");
}

const args = process.argv.slice(2);
if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
  if (args.length !== 1) {
    console.error("error: --help cannot be combined with other arguments");
    process.exitCode = 2;
  } else {
    console.log(usage());
  }
} else if (args.length > 0) {
  console.error("error: unknown argument: " + args[0]);
  console.error(usage());
  process.exitCode = 2;
} else {
  console.log(JSON.stringify(buildReport(), null, 2));
}
