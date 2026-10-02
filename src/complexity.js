import { VISITOR_KEYS } from "@babel/types";
import { emptyMetrics } from "./schema.js";

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
  };
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

  if (nesting > state.metrics.maxNesting) state.metrics.maxNesting = nesting;

  switch (node.type) {
    case "IfStatement":
      walkIf(node, nesting, state);
      return;
    case "ConditionalExpression":
      addCognitive(state, 1 + nesting);
      addCyclomatic(state, 1);
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
        if (logicalOp !== "??") addCognitive(state, 1 + nesting);
        if (countsAsDecision(logicalOp, state.options)) addCyclomatic(state, 1);
      }
      walkChildren(node, nesting, state);
      return;
    case "VariableDeclarator":
      if (node.id?.type === "Identifier" && isFunctionNode(node.init)) {
        state.scopes.at(-1).set(node.id.name, node.init);
      }
      walk(node.id, nesting, state);
      walk(node.init, nesting, state);
      return;
    case "BreakStatement":
    case "ContinueStatement":
      if (node.label) addCognitive(state, 1 + nesting);
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
        state.metrics.imports += 1;
        return;
      }
      state.metrics.imports += node.specifiers.filter((spec) => spec.importKind !== "type").length;
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
  addCognitive(state, 1 + nesting);
  addCyclomatic(state, 1);
  walk(node.test, nesting, state);
  walk(node.consequent, nesting + 1, state);
  let alt = node.alternate;
  while (alt) {
    if (alt.type === "IfStatement") {
      addCognitive(state, 1);
      addCyclomatic(state, 1);
      walk(alt.test, nesting, state);
      walk(alt.consequent, nesting + 1, state);
      alt = alt.alternate;
    } else {
      addCognitive(state, 1);
      walk(alt, nesting + 1, state);
      break;
    }
  }
}

function walkSwitch(node, nesting, state) {
  addCognitive(state, 1 + nesting);
  walk(node.discriminant, nesting, state);
  for (const item of node.cases || []) {
    if (item.test) {
      addCyclomatic(state, 1);
      walk(item.test, nesting, state);
    }
    for (const stmt of item.consequent || []) walk(stmt, nesting + 1, state);
  }
}

function walkTry(node, nesting, state) {
  walk(node.block, nesting, state);
  if (node.handler) {
    addCognitive(state, 1 + nesting);
    addCyclomatic(state, 1);
    if (node.handler.param) walk(node.handler.param, nesting, state);
    walk(node.handler.body, nesting + 1, state);
  }
  if (node.finalizer) walk(node.finalizer, nesting, state);
}

function walkLoop(node, nesting, state) {
  addCognitive(state, 1 + nesting);
  addCyclomatic(state, 1);
  const keys = VISITOR_KEYS[node.type] || [];
  for (const key of keys) {
    if (key === "body") continue;
    walkValue(node[key], nesting, state);
  }
  walk(node.body, nesting + 1, state);
}

function walkLogical(node, nesting, state) {
  const items = [];
  flattenLogical(node, items, true);
  let lastOp = null;
  for (const item of items) {
    if (item.op) {
      if (item.op !== lastOp) {
        if (item.op !== "??") addCognitive(state, 1 + nesting);
        lastOp = item.op;
      }
      if (countsAsDecision(item.op, state.options)) addCyclomatic(state, 1);
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
    items.push({ op: node.operator });
    flattenLogical(node.right, items, false);
    return;
  }
  items.push({ node });
}

function walkFunction(node, nesting, state) {
  const name = functionName(node);
  if (state.insideFunction && name && isComponentName(name)) state.metrics.nestedComponents += 1;
  state.metrics.functions += 1;
  if (node.loc) {
    const length = node.loc.end.line - node.loc.start.line + 1;
    if (length > state.metrics.maxFunctionLength) state.metrics.maxFunctionLength = length;
  }

  const propCount = countProps(node);
  const bodyNesting = state.insideFunction ? nesting + 1 : 0;
  const cycBefore = state.metrics.cyclomatic;
  const nestedBefore = state.nestedDecisions;
  const prevInside = state.insideFunction;
  state.insideFunction = true;
  state.scopes.push(new Map());
  if (name) state.scopes.at(-1).set(name, node);
  state.functionNodes.push(node);
  state.functionStack.push({ seenJSX: false, isComponent: Boolean(name && isComponentName(name)) });
  if (bodyNesting > state.metrics.maxNesting) state.metrics.maxNesting = bodyNesting;

  walkValue(node.params, bodyNesting, state);
  walk(node.body, bodyNesting, state);

  const frame = state.functionStack.pop();
  state.functionNodes.pop();
  state.scopes.pop();
  state.insideFunction = prevInside;
  const ownDecisions = state.metrics.cyclomatic - cycBefore - (state.nestedDecisions - nestedBefore);
  state.nestedDecisions += ownDecisions;
  const mccabe = 1 + ownDecisions;
  if (mccabe > state.metrics.maxCyclomatic) state.metrics.maxCyclomatic = mccabe;
  if (frame.seenJSX || frame.isComponent) {
    if (propCount > state.metrics.maxProps) state.metrics.maxProps = propCount;
  }
}

function walkJsxElement(node, nesting, state) {
  state.metrics.jsxElements += 1;
  const depth = state.jsxDepth + 1;
  state.jsxDepth = depth;
  if (depth > state.metrics.jsxDepth) state.metrics.jsxDepth = depth;
  markJSX(state);

  for (const attr of node.openingElement?.attributes || []) {
    if (!attr) continue;
    if (attr.type === "JSXSpreadAttribute") state.metrics.spreads += 1;
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
  if (depth > state.metrics.jsxDepth) state.metrics.jsxDepth = depth;
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
  state.metrics.jsxExpressions += 1;
  if (isFunctionNode(expr)) state.metrics.inlineHandlers += 1;
  if (isConditionalRender(expr)) state.metrics.conditionals += 1;
}

function noteJsxChild(child, state) {
  if (!child || child.type !== "JSXExpressionContainer") return;
  const expr = unwrapExpression(child.expression);
  if (!expr || expr.type === "JSXEmptyExpression") return;
  state.metrics.jsxExpressions += 1;
  if (isConditionalRender(expr)) state.metrics.conditionals += 1;
}

function noteCall(node, nesting, state) {
  const name = calleeName(node.callee);
  if (name && isHookName(name, state.options.hookPattern)) {
    state.metrics.hooks += 1;
    if (EFFECT_HOOKS.has(name)) {
      state.metrics.effects += 1;
      noteDeps(node, state, "effectDeps", "effectsWithoutDeps", name === "useImperativeHandle" ? 2 : 1);
    } else if (STATE_HOOKS.has(name)) {
      state.metrics.stateHooks += 1;
    } else if (MEMO_HOOKS.has(name)) {
      state.metrics.memoHooks += 1;
      noteDeps(node, state, "memoDeps", null);
    } else {
      state.metrics.customHooks += 1;
    }
  }
  if (isRecursiveCall(node, state)) addCognitive(state, 1);
  if (name === "require") state.metrics.imports += 1;
  void nesting;
}

function noteDeps(node, state, depsKey, missingKey, index = 1) {
  const deps = node.arguments?.[index];
  const expr = unwrapExpression(deps);
  if (!deps || (expr?.type === "Identifier" && expr.name === "undefined")) {
    if (missingKey) state.metrics[missingKey] += 1;
    return;
  }
  if (expr?.type === "ArrayExpression" && depsKey) {
    state.metrics[depsKey] += expr.elements.filter((item) => item && item.type !== "SpreadElement").length;
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
  return null;
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

function addCognitive(state, amount) {
  state.metrics.cognitive += amount;
}

function addCyclomatic(state, amount) {
  state.metrics.cyclomatic += amount;
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
  if (first.type === "ObjectPattern") return first.properties.length;
  if (first.type === "Identifier") return 1;
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
