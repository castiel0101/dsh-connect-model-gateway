/**
 * WorkBuddy 失败分类（逐字取自 dsh-connect-workbuddy 5.21.3，MIT）。
 *
 * 为什么重要：宿主靠 HTTP 状态与 code 决定「原地重试」还是「换渠道」。
 * 429 当普通限流重试会白烧预算；额度不足必须给 402 而不是 429。
 *
 * @module dsh-connect-model-gateway/core/workbuddy-errors
 */

const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"credits exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"credits not enough",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];

const CREDITS_EXHAUSTED_CODE = 14018;

const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];

const CHANNEL_REJECT_MARKERS = ["unapproved channel", "illegal api invocation"];

const CONVERSATION_ID_GATE_MARKER = "conversation id missing";

const FIRST_MESSAGE_GATE_MARKER = "first message is not system prompt";

function statesBusinessCode(body, code) {
	const stated = businessCodeOf(body);
	if (stated !== void 0) return stated === code;
	return body.toLowerCase().includes(`"code":${code}`);
}

function isAccountRestrictedBody(body) {
	if (!isContentPolicyBody(body)) return false;
	const haystack = accountVerdictText(body);
	if (haystack === "") return false;
	return ACCOUNT_RESTRICTED_MARKERS.some((marker) => haystack.includes(normalizeVerdictText(marker)));
}

function isContentPolicyBody(body) {
	return statesBusinessCode(body, CONTENT_POLICY_CODE);
}

function isChannelRejectBody(body) {
	return isChannelGateFamilyBody(body);
}

function isModelBusyBody(body) {
	return statesBusinessCode(body, MODEL_BUSY_CODE);
}

function parseQueueAnswer(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	const direct = readEnvelope$1(parsed);
	if (direct !== void 0) return direct;
	if (typeof parsed === "object" && parsed !== null) {
		const meta = parsed["_meta"];
		if (typeof meta === "object" && meta !== null) {
			const message = meta["codebuddy.ai/errorMessage"];
			if (typeof message === "string") try {
				return readEnvelope$1(JSON.parse(message));
			} catch {
				return;
			}
		}
	}
}

function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	if (statesBusinessCode(body, CREDITS_EXHAUSTED_CODE)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (isAccountRestrictedBody(body)) return "account_restricted";
	if (isContentPolicyBody(body)) return "policy_reject";
	if (isChannelRejectBody(body)) return "channel_reject";
	if (isModelBusyBody(body)) return "model_busy";
	if (parseQueueAnswer(body) !== void 0) return "model_queue";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/** 失败类别 → HTTP 状态。与旧插件一致。 */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	model_busy: 429,
	session_dead: 401,
	policy_reject: 403,
	account_restricted: 403,
	channel_reject: 400,
	model_queue: 429,
	not_found: 502,
	server: 502,
	client: 400,
};

/**
 * 写给宿主的 code：只有 soft_rate 需要翻译成 quota_exceeded，
 * 否则宿主会把它当普通限流原地重试。
 */
const KIND_HOST_CODE = { soft_rate: 'quota_exceeded' };

function hostErrorCode(kind) {
	return KIND_HOST_CODE[kind] ?? kind;
}


function businessCodeOf(body) {
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		const match = /"code"\s*:\s*"?(\d{4,6}(?!\d))/u.exec(body);
		return match?.[1] === void 0 ? void 0 : Number(match[1]);
	}
	if (typeof parsed !== "object" || parsed === null) return void 0;
	return businessCodeOfDocument(parsed);
}

function businessCodeOfDocument(raw) {
	const direct = asBusinessCode(raw["code"]);
	if (direct !== void 0) return direct;
	const error = raw["error"];
	if (typeof error === "object" && error !== null) {
		const data = error["data"];
		if (typeof data === "object" && data !== null) {
			const nested = asBusinessCode(data["code"]);
			if (nested !== void 0) return nested;
		}
		const direct = asBusinessCode(error["code"]);
		if (direct !== void 0) return direct;
	}
	const data = raw["data"];
	if (typeof data === "object" && data !== null) return asBusinessCode(data["code"]);
}

const CONTENT_POLICY_CODE = 11140;
const CHANNEL_REJECT_CODE = 11128;
const MODEL_BUSY_CODE = 14003;

function isChannelGateFamilyBody(body) {
	return statesBusinessCode(body, CHANNEL_REJECT_CODE);
}

function asBusinessCode(value) {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^\d{4,6}$/u.test(value.trim())) return Number(value.trim());
}

function accountVerdictText(body) {
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return normalizeVerdictText(body);
	}
	if (typeof parsed !== "object" || parsed === null) return "";
	const raw = parsed;
	return normalizeVerdictText([
		localizedText(raw["displayMsg"]),
		localizedText(raw["displayTips"]),
		typeof raw["msg"] === "string" ? raw["msg"] : void 0
	].filter((value) => typeof value === "string").join(" "));
}

function normalizeVerdictText(text) {
	return text.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function localizedText(value) {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null) return void 0;
	const localized = value;
	const pick = localized.zh ?? localized.en;
	return typeof pick === "string" ? pick : void 0;
}

const ACCOUNT_RESTRICTED_MARKERS = ["账号存在异常行为", "restricted due to unusual activity"];

export { classifyUpstreamError, hostErrorCode, KIND_STATUS };
