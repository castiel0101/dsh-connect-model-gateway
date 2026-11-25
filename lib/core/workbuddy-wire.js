/**
 * WorkBuddy 请求头（逐字取自 dsh-connect-workbuddy 5.21.3，MIT，Copyright (c) 2026 LaoDing）。
 *
 * 渠道校验要求请求长得像官方客户端：UA、Origin/Referer、X-Product / X-IDE-*、
 * X-User-Id / X-Enterprise-Id / X-Domain，以及 chat 专用的会话身份三件套。
 *
 * deviceHeaders 有意不移植：它需要本机盐与设备 token，缺席时旧插件也是整对不发，
 * 因此这里等价于「不发」。
 *
 * @module dsh-connect-model-gateway/core/workbuddy-wire
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";

const GLOBAL_BASE = "https://www.workbuddy.ai";

const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

const PRODUCT_UA = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";

const ATTRIBUTION_CLIENT_NAME = "WorkBuddy";

const DEFAULT_WIRE_PROFILE = "balanced";

function profileOf(identity) {
	return identity.profile ?? "balanced";
}

function globalBase(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
	return GLOBAL_BASE;
}

function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "global";
	return "cn";
}

function chatBase(credential, cnBase) {
	if (regionOf(credential.domain) === "global") return globalBase(credential.domain);
	return cnBase === void 0 || cnBase === "" ? CN_CHAT_BASE : cnBase;
}

function billingBase(credential, cnBase) {
	if (regionOf(credential.domain) === "global") return globalBase(credential.domain);
	return cnBase === void 0 || cnBase === "" ? CN_BILLING_BASE : cnBase;
}

function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential.domain) : CN_BILLING_BASE;
}

function acceptLanguageOf(credential) {
	return regionOf(credential.domain) === "global" ? "en-US" : "zh-CN";
}

function uuidv7(nowMs = Date.now()) {
	const bytes = randomBytes(16);
	for (let index = 0; index < 6; index++) bytes[index] = Math.floor(nowMs / 2 ** (8 * (5 - index))) & 255;
	bytes[6] = bytes[6] & 15 | 112;
	bytes[8] = bytes[8] & 63 | 128;
	return bytes.toString("hex");
}

const APP_VERSION = PRODUCT_UA.match(/WorkBuddy\/([^\s]+)/u)?.[1] ?? "5.8.3";

function legacyCommonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}

function commonHeaders(credential, identity = {}) {
	const headers = legacyCommonHeaders(credential);
	if (profileOf(identity) === "balanced") {
		headers["X-CodeBuddy-Request"] = "1";
		headers["Accept-Language"] = acceptLanguageOf(credential);
	}
	return headers;
}

function attributionHeaders(identity) {
	if (profileOf(identity) !== "balanced") return { "X-Product": "SaaS" };
	return {
		"X-Agent-Purpose": "conversation",
		"X-IDE-Name": ATTRIBUTION_CLIENT_NAME,
		"X-IDE-Type": ATTRIBUTION_CLIENT_NAME,
		"X-IDE-Version": APP_VERSION,
		"X-Product": ATTRIBUTION_CLIENT_NAME
	};
}

function conversationHeaders(shape, identity = {}) {
	const officialIds = shape === "chat" && identity.usageIdentity === true;
	const id = officialIds ? uuidv7 : randomUUID;
	const messageId = id();
	const conversationRequestId = id();
	return {
		"X-Conversation-ID": id(),
		"X-Conversation-Request-ID": conversationRequestId,
		...profileOf(identity) === "balanced" ? { "X-Root-Request-ID": conversationRequestId } : {},
		"X-Conversation-Message-ID": messageId,
		...officialIds ? { "X-Request-ID": messageId } : {}
	};
}

function chatHeaders(credential, identity = {}) {
	return {
		...commonHeaders(credential, identity),
		"Content-Type": "application/json",
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		...attributionHeaders(identity),
		...deviceHeaders(credential, identity),
		...conversationHeaders("chat", identity)
	};
}

function deviceHeaders() {
	return {};
}


export {
	CN_CHAT_BASE,
	GLOBAL_BASE,
	CLIENT_UA,
	PRODUCT_UA,
	ATTRIBUTION_CLIENT_NAME,
	regionOf,
	chatBase,
	billingBase,
	originReferer,
	acceptLanguageOf,
	chatHeaders,
};
