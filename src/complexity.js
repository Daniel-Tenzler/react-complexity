import { VISITOR_KEYS } from "@babel/types";
import { emptyMetrics, DEFAULT_NOTE_THRESHOLDS, DEFAULT_REACT_PACKAGES } from "./schema.js";

const FUNCTION_NODES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

const LOOP_NODES = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const TS_WRAPPERS = new Set([
  "TSAsExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSInstantiationExpression",
]);

const EFFECT_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useImperativeHandle",
]);

const STATE_HOOKS = new Set(["useState", "useReducer"]);
const MEMO_HOOKS = new Set(["useMemo", "useCallback"]);
const REACT_HOOKS = new Set([
  ...EFFECT_HOOKS, ...STATE_HOOKS, ...MEMO_HOOKS,
  "useContext", "useRef", "useDebugValue", "useId", "useTransition",
  "useDeferredValue", "useSyncExternalStore", "useActionState", "useOptimistic", "useEffectEvent",
]);
const SKIP_WALK_KEYS = new Set(["typeAnnotation", "returnType", "typeParameters", "predicate"]);

export function measure(program, options, skipNodes) {
  const metrics = emptyMetrics();
  const state = {
    metrics,
    options,
    insideFunction: false,
    functionNodes: [],
    functionStack: [],
    scopes: [new Map()],
    jsxDepth: 0,
    skipNodes: skipNodes || null,
    nestedDecisions: 0,
    functionNames: new WeakMap(),
  };
  declareStatements(options.program?.body || (program.type === "Program" ? program.body : []), state);
  walk(program, 0, state);
  return metrics;
}

function walk(node, nesting, state) {
  if (!node || typeof node.type !== "string") return;
  if (state.skipNodes?.has(node)) return;
  if (node.declare) return;
  if (node.type.startsWith("TS")) {
    if (TS_WRAPPERS.has(node.type)) {
      walk(node.expression, nesting, state);
      return;
    }
    if (node.type === "TSParameterProperty") {
      walk(node.parameter, nesting, state);
      return;
    }
    if (node.type === "TSEnumDeclaration") {
      for (const member of node.members || []) walk(member?.initializer, nesting, state);
      return;
    }
    return;
  }

  maxMetric(state, "maxNesting", nesting, node);

  switch (node.type) {
    case "BlockStatement":
      state.scopes.push(new Map());
      declareStatements(node.body, state);
      for (const statement of node.body) walk(statement, nesting, state);
      state.scopes.pop();
      return;
    case "IfStatement":
      walkIf(node, nesting, state);
      return;
    case "ConditionalExpression":
      addCognitive(state, 1 + nesting, node);
      addCyclomatic(state, 1, node);
      walk(node.test, nesting, state);
      walk(node.consequent, nesting + 1, state);
      walk(node.alternate, nesting + 1, state);
      return;
    case "SwitchStatement":
      walkSwitch(node, nesting, state);
      return;
    case "TryStatement":
      walkTry(node, nesting, state);
      return;
    case "LogicalExpression":
      walkLogical(node, nesting, state);
      return;
    case "AssignmentExpression":
      if (node.operator === "&&=" || node.operator === "||=" || node.operator === "??=") {
        const logicalOp = node.operator.slice(0, -1);
        if (logicalOp !== "??") addCognitive(state, 1 + nesting, node);
        if (countsAsDecision(logicalOp, state.options)) addCyclomatic(state, 1, node);
      }
      walkChildren(node, nesting, state);
      return;
    case "VariableDeclarator":
      walk(node.id, nesting, state);
      walk(node.init, nesting, state);
      return;
    case "BreakStatement":
    case "ContinueStatement":
      if (node.label) addCognitive(state, 1 + nesting, node);
      return;
    case "CallExpression":
    case "OptionalCallExpression":
      noteCall(node, nesting, state);
      walk(node.callee, nesting, state);
      for (const arg of node.arguments || []) walk(arg, nesting, state);
      return;
    case "ImportDeclaration":
      if (node.importKind === "type") return;
      if (!node.specifiers?.length) {
        addMetric(state, "imports", 1, node);
        return;
      }
      for (const spec of node.specifiers.filter((spec) => spec.importKind !== "type")) addMetric(state, "imports", 1, spec);
      return;
    case "JSXElement":
      walkJsxElement(node, nesting, state);
      return;
    case "JSXFragment":
      walkJsxFragment(node, nesting, state);
      return;
    default:
      break;
  }

  if (FUNCTION_NODES.has(node.type)) {
    walkFunction(node, nesting, state);
    return;
  }

  walkChildren(node, nesting, state);
}

function walkIf(node, nesting, state) {
  addCognitive(state, 1 + nesting, node);
  addCyclomatic(state, 1, node);
  walk(node.test, nesting, state);
  walk(node.consequent, nesting + 1, state);
  let alt = node.alternate;
  while (alt) {
    if (alt.type === "IfStatement") {
      addCognitive(state, 1, alt);
      addCyclomatic(state, 1, alt);
      walk(alt.test, nesting, state);
      walk(alt.consequent, nesting + 1, state);
      alt = alt.alternate;
    } else {
      addCognitive(state, 1, alt);
      walk(alt, nesting + 1, state);
      break;
    }
  }
}

function walkSwitch(node, nesting, state) {
  addCognitive(state, 1 + nesting, node);
  walk(node.discriminant, nesting, state);
  state.scopes.push(new Map());
  declareStatements((node.cases || []).flatMap((item) => item.consequent || []), state);
  for (const item of node.cases || []) {
    if (item.test) {
      addCyclomatic(state, 1, item);
      walk(item.test, nesting, state);
    }
    for (const stmt of item.consequent || []) walk(stmt, nesting + 1, state);
  }
  state.scopes.pop();
}

function walkTry(node, nesting, state) {
  walk(node.block, nesting, state);
  if (node.handler) {
    addCognitive(state, 1 + nesting, node.handler);
    addCyclomatic(state, 1, node.handler);
    state.scopes.push(new Map());
    declarePattern(node.handler.param, null, state.scopes.at(-1));
    if (node.handler.param) walk(node.handler.param, nesting, state);
    walk(node.handler.body, nesting + 1, state);
    state.scopes.pop();
  }
  if (node.finalizer) walk(node.finalizer, nesting, state);
}

function walkLoop(node, nesting, state) {
  addCognitive(state, 1 + nesting, node);
  addCyclomatic(state, 1, node);
  state.scopes.push(new Map());
  declareStatements([node.init, node.left].filter(Boolean), state);
  const keys = VISITOR_KEYS[node.type] || [];
  for (const key of keys) {
    if (key === "body") continue;
    walkValue(node[key], nesting, state);
  }
  walk(node.body, nesting + 1, state);
  state.scopes.pop();
}

function walkLogical(node, nesting, state) {
  const items = [];
  flattenLogical(node, items, true);
  let lastOp = null;
  for (const item of items) {
    if (item.op) {
      if (item.op !== lastOp) {
        if (item.op !== "??") addCognitive(state, 1 + nesting, item.node);
        lastOp = item.op;
      }
      if (countsAsDecision(item.op, state.options)) addCyclomatic(state, 1, item.node);
    } else {
      walk(item.node, nesting, state);
    }
  }
}

function flattenLogical(node, items, isRoot) {
  if (
    node &&
    node.type === "LogicalExpression" &&
    (node.operator === "&&" || node.operator === "||" || node.operator === "??") &&
    (isRoot || !node.extra?.parenthesized)
  ) {
    flattenLogical(node.left, items, false);
    items.push({ op: node.operator, node });
    flattenLogical(node.right, items, false);
    return;
  }
  items.push({ node });
}

function walkFunction(node, nesting, state) {
  const name = state.functionNames.get(node) || functionName(node);
  const isComponent = Boolean(name && (isComponentName(name) || (isMethod(node) && name === "render")) && containsJSX(node, true));
  if (isComponent && state.functionStack.some((frame) => frame.isComponent)) {
    addMetric(state, "nestedComponents", 1, node);
    finding(state, "nestedComponents", node, `Component ${name} is defined inside another component`,
      "Consider moving it to module scope and passing its inputs as props; nested definitions can reset child state.");
  }
  addMetric(state, "functions", 1, node);
  if (node.loc) {
    const length = node.loc.end.line - node.loc.start.line + 1;
    maxMetric(state, "maxFunctionLength", length, node);
  }

  const propCount = countProps(node);
  const bodyNesting = state.insideFunction ? nesting + 1 : 0;
  const cycBefore = state.metrics.cyclomatic;
  const cognitiveBefore = state.metrics.cognitive;
  const nestedBefore = state.nestedDecisions;
  const prevInside = state.insideFunction;
  state.insideFunction = true;
  state.scopes.push(new Map());
  if (node.id?.name) state.scopes.at(-1).set(node.id.name, node);
  for (const param of node.params || []) declarePattern(param, null, state.scopes.at(-1));
  declareFunctionVars(node.body, state);
  state.functionNodes.push(node);
  state.functionStack.push({ seenJSX: false, isComponent });
  maxMetric(state, "maxNesting", bodyNesting, node);

  walkValue(node.params, bodyNesting, state);
  walk(node.body, bodyNesting, state);

  const frame = state.functionStack.pop();
  state.functionNodes.pop();
  state.scopes.pop();
  state.insideFunction = prevInside;
  const ownDecisions = state.metrics.cyclomatic - cycBefore - (state.nestedDecisions - nestedBefore);
  state.nestedDecisions += ownDecisions;
  const mccabe = 1 + ownDecisions;
  maxMetric(state, "maxCyclomatic", mccabe, node);
  if (frame.seenJSX || frame.isComponent) {
    maxMetric(state, "maxProps", propCount, node.params?.[0] || node);
  }
  const cognitive = state.metrics.cognitive - cognitiveBefore;
  if (cognitive >= limit(state, "cognitive")) {
    finding(state, "cognitive", node, `${name || "Anonymous function"} has cognitive complexity ${cognitive} (including nested functions)`,
      "Review nested branches and mixed responsibilities; guard clauses or focused helpers may simplify this function.");
  }
  const length = node.loc ? node.loc.end.line - node.loc.start.line + 1 : 0;
  if (length >= limit(state, "maxFunctionLength")) {
    finding(state, "maxFunctionLength", node, `${name || "Anonymous function"} spans ${length} lines`,
      "Check for distinct responsibilities before extracting smaller functions; length alone is not a defect.");
  }
}

function walkJsxElement(node, nesting, state) {
  addMetric(state, "jsxElements", 1, node.openingElement);
  const depth = state.jsxDepth + 1;
  state.jsxDepth = depth;
  maxMetric(state, "jsxDepth", depth, node.openingElement);
  noteJsxDepth(node, depth, state);
  markJSX(state);

  for (const attr of node.openingElement?.attributes || []) {
    if (!attr) continue;
    if (attr.type === "JSXSpreadAttribute") addMetric(state, "spreads", 1, attr);
    if (attr.type === "JSXAttribute") noteJsxAttribute(attr, state);
  }
  for (const child of node.children || []) noteJsxChild(child, state);

  walk(node.openingElement, nesting, state);
  walk(node.closingElement, nesting, state);
  for (const child of node.children || []) walk(child, nesting, state);
  state.jsxDepth = depth - 1;
}

function walkJsxFragment(node, nesting, state) {
  const depth = state.jsxDepth + 1;
  state.jsxDepth = depth;
  maxMetric(state, "jsxDepth", depth, node.openingFragment);
  noteJsxDepth(node, depth, state);
  markJSX(state);
  for (const child of node.children || []) {
    noteJsxChild(child, state);
    walk(child, nesting, state);
  }
  state.jsxDepth = depth - 1;
}

function noteJsxAttribute(attr, state) {
  const expr = jsxExpression(attr.value);
  if (!expr) return;
  addMetric(state, "jsxExpressions", 1, attr.value);
  if (isFunctionNode(expr)) {
    addMetric(state, "inlineHandlers", 1, attr);
    finding(state, "inlineHandlers", attr, `Inline function passed to JSX prop ${attr.name?.name || "(unknown)"}`,
      "Keep it inline if it is clear. Extract it for readability when substantial; optimize identity only when profiling or an API requires it.");
  }
  if (isConditionalRender(expr)) addMetric(state, "conditionals", 1, expr);
}

function noteJsxChild(child, state) {
  if (!child || child.type !== "JSXExpressionContainer") return;
  const expr = unwrapExpression(child.expression);
  if (!expr || expr.type === "JSXEmptyExpression") return;
  addMetric(state, "jsxExpressions", 1, child);
  if (isConditionalRender(expr)) addMetric(state, "conditionals", 1, expr);
}

function noteCall(node, nesting, state) {
  const name = calleeName(node.callee);
  const hook = hookName(node.callee, state);
  if (hook) {
    addMetric(state, "hooks", 1, node);
    if (EFFECT_HOOKS.has(hook)) {
      addMetric(state, "effects", 1, node);
      noteDeps(node, state, "effectDeps", "effectsWithoutDeps", hook === "useImperativeHandle" ? 2 : 1);
    } else if (STATE_HOOKS.has(hook)) {
      addMetric(state, "stateHooks", 1, node);
    } else if (MEMO_HOOKS.has(hook)) {
      addMetric(state, "memoHooks", 1, node);
      noteDeps(node, state, "memoDeps", null);
    } else {
      addMetric(state, "customHooks", 1, node);
    }
  }
  if (isRecursiveCall(node, state)) addCognitive(state, 1, node);
  if (name === "require") addMetric(state, "imports", 1, node);
  void nesting;
}

function noteDeps(node, state, depsKey, missingKey, index = 1) {
  const deps = node.arguments?.[index];
  const expr = unwrapExpression(deps);
  if (!deps || (expr?.type === "Identifier" && expr.name === "undefined")) {
    if (missingKey) {
      addMetric(state, missingKey, 1, node);
      finding(state, missingKey, node, `${calleeName(node.callee)} has no dependency array`,
        "This runs after every applicable render and may be intentional. Review synchronization needs; do not add an empty array without checking dependencies.");
    }
    return;
  }
  if (expr?.type === "ArrayExpression" && depsKey) {
    for (const item of expr.elements.filter((item) => item && item.type !== "SpreadElement")) addMetric(state, depsKey, 1, item);
  }
}

function isRecursiveCall(node, state) {
  const current = state.functionNodes.at(-1);
  const callee = node.callee;
  if (!current || !callee) return false;
  if (callee.type === "Identifier") return resolveBinding(state, callee.name) === current;
  if (
    (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
    !callee.computed &&
    callee.object?.type === "ThisExpression"
  ) {
    const propName = propertyName(callee.property);
    return Boolean(propName) && functionName(current) === propName && isMethod(current);
  }
  return false;
}

function resolveBinding(state, name) {
  for (let i = state.scopes.length - 1; i >= 0; i--) {
    if (state.scopes[i].has(name)) return state.scopes[i].get(name);
  }
  return undefined;
}

function declarePattern(pattern, value, scope) {
  if (!pattern) return;
  if (pattern.type === "Identifier") scope.set(pattern.name, value);
  else if (pattern.type === "AssignmentPattern") declarePattern(pattern.left, value, scope);
  else if (pattern.type === "RestElement") declarePattern(pattern.argument, value, scope);
  else if (pattern.type === "ObjectPattern") {
    for (const prop of pattern.properties) declarePattern(prop.value || prop.argument, value, scope);
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) declarePattern(element, value, scope);
  }
}

function declareStatements(statements, state) {
  const scope = state.scopes.at(-1);
  for (const statement of statements || []) {
    const stmt = statement.declaration || statement;
    if (stmt.type === "ImportDeclaration") {
      const source = String(stmt.source.value);
      const react = (state.options.reactPackages || DEFAULT_REACT_PACKAGES)
        .some((pkg) => source === pkg || source.startsWith(`${pkg}/`));
      for (const spec of stmt.specifiers || []) {
        const runtime = stmt.importKind !== "type" && spec.importKind !== "type";
        const imported = spec.imported?.name || spec.imported?.value;
        scope.set(spec.local.name, react && runtime
          ? { kind: imported ? "react-hook" : "react-namespace", name: imported }
          : null);
      }
    } else if (stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") {
      if (stmt.id) scope.set(stmt.id.name, stmt);
    } else if (stmt.type === "VariableDeclaration") {
      for (const item of stmt.declarations) {
        const init = unwrapExpression(item.init);
        declarePattern(item.id, isFunctionNode(init) ? init : null, scope);
        let fn = init;
        while (fn?.type === "CallExpression" && ["memo", "forwardRef", "observer"].includes(calleeName(fn.callee))) {
          fn = unwrapExpression(fn.arguments[0]);
        }
        if (item.id.type === "Identifier" && isFunctionNode(fn)) state.functionNames.set(fn, item.id.name);
      }
    }
  }
}

function declareFunctionVars(node, state) {
  if (!node || isFunctionNode(node) || node.type === "ClassDeclaration" || node.type === "ClassExpression") return;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    declareStatements([node], state);
  }
  for (const key of VISITOR_KEYS[node.type] || []) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) declareFunctionVars(child, state);
    } else declareFunctionVars(value, state);
  }
}

function hookName(callee, state) {
  if (callee?.type === "Identifier") {
    const binding = resolveBinding(state, callee.name);
    const name = binding?.kind === "react-hook" ? binding.name : callee.name;
    if (!isHookName(name, state.options.hookPattern)) return null;
    // Known React hooks bound to something else must not acquire React semantics.
    if (binding !== undefined && binding?.kind !== "react-hook" && REACT_HOOKS.has(name)) return null;
    return name;
  }
  if ((callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
      !callee.computed && callee.object?.type === "Identifier") {
    const binding = resolveBinding(state, callee.object.name);
    if (binding?.kind !== "react-namespace" && !(binding === undefined && callee.object.name === "React")) return null;
    const name = calleeName(callee);
    return isHookName(name, state.options.hookPattern) ? name : null;
  }
  return null;
}

function limit(state, metric) {
  return state.options.noteThresholds?.[metric] ?? DEFAULT_NOTE_THRESHOLDS[metric];
}

function finding(state, metric, node, message, suggestion) {
  if (!node.loc || !state.options.onFinding) return;
  state.options.onFinding({
    metric,
    message,
    location: {
      start: { line: node.loc.start.line, column: node.loc.start.column + 1 },
      end: { line: node.loc.end.line, column: node.loc.end.column + 1 },
    },
    suggestion,
  });
}

function noteJsxDepth(node, depth, state) {
  if (depth === limit(state, "jsxDepth")) {
    finding(state, "jsxDepth", node.openingElement || node.openingFragment || node,
      `JSX nesting reaches ${depth} levels`,
      "Consider extracting a meaningful UI section if it improves readability; avoid splitting markup solely to reduce this number.");
  }
}

function propertyName(property) {
  if (property?.type === "Identifier") return property.name;
  if (property?.type === "PrivateName") return property.id?.name || null;
  return null;
}

function isMethod(node) {
  return node.type === "ClassMethod" || node.type === "ClassPrivateMethod" || node.type === "ObjectMethod";
}

function walkChildren(node, nesting, state) {
  if (LOOP_NODES.has(node.type)) {
    walkLoop(node, nesting, state);
    return;
  }
  const keys = VISITOR_KEYS[node.type];
  if (!keys) return;
  for (const key of keys) {
    if (SKIP_WALK_KEYS.has(key)) continue;
    walkValue(node[key], nesting, state);
  }
}

function walkValue(value, nesting, state) {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, nesting, state);
    return;
  }
  walk(value, nesting, state);
}

function addMetric(state, metric, value, node) {
  state.metrics[metric] += value;
  if (value > 0) state.options.onMetricSource?.(metric, value, node, false);
}

function maxMetric(state, metric, value, node) {
  if (value <= state.metrics[metric]) return;
  state.metrics[metric] = value;
  state.options.onMetricSource?.(metric, value, node, true);
}

function addCognitive(state, amount, node) {
  addMetric(state, "cognitive", amount, node);
}

function addCyclomatic(state, amount, node) {
  addMetric(state, "cyclomatic", amount, node);
}

function countsAsDecision(op, options) {
  if (op === "??") return options.countNullish !== false;
  if (op === "&&" || op === "||") return options.countLogical !== false;
  return false;
}

function markJSX(state) {
  const frame = state.functionStack.at(-1);
  if (frame) frame.seenJSX = true;
}

function countProps(fn) {
  const params = fn.params || [];
  if (params.length === 0) return 0;
  let first = params[0];
  if (first.type === "AssignmentPattern") first = first.left;
  if (first.type === "ObjectPattern") return first.properties.filter((prop) => prop.type !== "RestElement").length;
  return 0;
}

function functionName(node) {
  if (node.id?.type === "Identifier") return node.id.name;
  if (node.key && !node.computed) {
    if (node.key.type === "Identifier") return node.key.name;
    if (node.key.type === "PrivateName") return node.key.id?.name || null;
    if (node.key.type === "StringLiteral") return node.key.value;
  }
  return null;
}

function isComponentName(name) {
  return /^[A-Z]/.test(name);
}

function isHookName(name, pattern) {
  if (!name) return false;
  try {
    return new RegExp(pattern || "^use[A-Z]").test(name);
  } catch {
    return /^use[A-Z]/.test(name);
  }
}

export function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (
    (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
    !callee.computed &&
    callee.property?.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

export function isFunctionNode(node) {
  return Boolean(node && FUNCTION_NODES.has(node.type));
}

export function unwrapExpression(node) {
  let current = node;
  while (current && TS_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

function jsxExpression(value) {
  if (!value || value.type !== "JSXExpressionContainer") return null;
  const expr = unwrapExpression(value.expression);
  if (!expr || expr.type === "JSXEmptyExpression") return null;
  return expr;
}

function isConditionalRender(expr) {
  const node = unwrapExpression(expr);
  if (!node) return false;
  if (node.type === "ConditionalExpression") return containsJSX(node);
  if (node.type === "LogicalExpression") return containsJSX(node);
  return false;
}

export function containsJSX(node, stopAtFunction = false) {
  let found = false;
  const visit = (current) => {
    if (!current || found || typeof current.type !== "string") return;
    if (stopAtFunction && current !== node && FUNCTION_NODES.has(current.type)) return;
    if (current.type === "JSXElement" || current.type === "JSXFragment") {
      found = true;
      return;
    }
    if (current.type.startsWith("TS")) {
      if (TS_WRAPPERS.has(current.type)) visit(current.expression);
      return;
    }
    const keys = VISITOR_KEYS[current.type];
    if (!keys) return;
    for (const key of keys) {
      const value = current[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value.type === "string") {
        visit(value);
      }
    }
  };
  visit(node);
  return found;
}
