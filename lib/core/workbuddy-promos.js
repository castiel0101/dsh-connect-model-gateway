/**
 * WorkBuddy 促销徽标（逐字取自 dsh-connect-workbuddy 5.21.3，MIT）。
 *
 * 上游在同一个模型目录文档里带 `modelPromotions` / `modelTiers`：这些条目描述
 * 「夜间免费」「限时折扣」这类时段活动。徽标必须在**渲染时**按当前时间挑选，
 * 不能在拉取时定稿，否则活动结束后徽标还会挂着。
 *
 * @module dsh-connect-model-gateway/core/workbuddy-promos
 */

function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}

function text(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}

function parseModelIds(value) {
	if (!Array.isArray(value)) return void 0;
	const ids = [];
	for (const entry of value) {
		const id = text(entry);
		if (id !== void 0 && !ids.includes(id)) ids.push(id);
	}
	return ids.length === 0 ? void 0 : ids;
}

function parseBadge(value) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	const label = text(raw["label"]) ?? text(raw["labelEn"]) ?? text(raw["shortLabel"]) ?? text(raw["shortLabelEn"]);
	if (label === void 0) return void 0;
	const labelEn = text(raw["labelEn"]);
	const shortLabel = text(raw["shortLabel"]);
	const shortLabelEn = text(raw["shortLabelEn"]);
	const color = text(raw["color"]);
	const display = raw["display"] === "activeOnly" ? "activeOnly" : void 0;
	return {
		label,
		...labelEn === void 0 ? {} : { labelEn },
		...shortLabel === void 0 ? {} : { shortLabel },
		...shortLabelEn === void 0 ? {} : { shortLabelEn },
		...color === void 0 ? {} : { color },
		...display === void 0 ? {} : { display }
	};
}

function parseHover(value) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	const textZh = text(raw["textZh"]);
	const textEn = text(raw["textEn"]);
	if (textZh === void 0 && textEn === void 0) return void 0;
	return {
		...textZh === void 0 ? {} : { textZh },
		...textEn === void 0 ? {} : { textEn }
	};
}

function parseInstant(value) {
	const raw = text(value);
	if (raw === void 0) return void 0;
	const ms = Date.parse(raw);
	return Number.isNaN(ms) ? void 0 : ms;
}

function parseDaily(value, label) {
	if (!Array.isArray(value)) return void 0;
	const windows = [];
	for (const entry of value) {
		const raw = record(entry);
		if (raw === void 0) continue;
		const start = text(raw["start"]);
		const end = text(raw["end"]);
		if (start === void 0 || end === void 0 || minutesOfClock(start) === void 0 || minutesOfClock(end) === void 0) {
			try {
				console.warn(`[dsh-connect-workbuddy] promotion "${label}": dropped an unreadable daily window (start: ${shapeOf(raw["start"])}, end: ${shapeOf(raw["end"])}); the upstream may have changed the time format`);
			} catch {}
			continue;
		}
		windows.push({
			start,
			end
		});
	}
	return windows.length === 0 ? void 0 : windows;
}

function parseSchedule(value, label) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	const timezone = text(raw["timezone"]);
	const validFrom = parseInstant(raw["validFrom"]);
	const validUntil = parseInstant(raw["validUntil"]);
	const daily = parseDaily(raw["daily"], label);
	const dailyUnusable = daily === void 0 && Array.isArray(raw["daily"]) && raw["daily"].length > 0;
	if (timezone === void 0 && validFrom === void 0 && validUntil === void 0 && daily === void 0 && !dailyUnusable) return void 0;
	return {
		...timezone === void 0 ? {} : { timezone },
		...validFrom === void 0 ? {} : { validFrom },
		...validUntil === void 0 ? {} : { validUntil },
		...daily === void 0 ? {} : { daily },
		...dailyUnusable ? { dailyUnusable: true } : {}
	};
}

function parseDiscount(value) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	const fromString = multiplierOfCredits(raw["discountedCredits"]);
	const fromFactor = typeof raw["factor"] === "number" && Number.isFinite(raw["factor"]) && raw["factor"] >= 0 ? raw["factor"] : void 0;
	const multiplier = fromString ?? fromFactor;
	const displayMode = raw["displayMode"] === "replace" || raw["displayMode"] === "strikethrough" ? raw["displayMode"] : void 0;
	if (multiplier === void 0 && displayMode === void 0) return void 0;
	return {
		...multiplier === void 0 ? {} : { multiplier },
		...displayMode === void 0 ? {} : { displayMode }
	};
}

function parsePromo(value, source) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	if (raw["enabled"] === false) return void 0;
	const modelIds = parseModelIds(raw["modelIds"]);
	if (modelIds === void 0) return void 0;
	const badge = parseBadge(raw["badge"]);
	if (badge === void 0) return void 0;
	const hover = parseHover(raw["hover"]);
	const id = text(raw["id"]) ?? `${source}:${modelIds.join(",")}`;
	const schedule = parseSchedule(raw["schedule"], id);
	const discount = parseDiscount(raw["discount"]);
	const priority = typeof raw["priority"] === "number" && Number.isFinite(raw["priority"]) ? raw["priority"] : 0;
	return {
		id,
		source,
		modelIds,
		badge,
		...hover === void 0 ? {} : { hover },
		...schedule === void 0 ? {} : { schedule },
		...discount === void 0 ? {} : { discount },
		priority
	};
}

function parseWorkBuddyPromos(rawPromotions, rawTiers) {
	const promos = [];
	for (const entry of Array.isArray(rawPromotions) ? rawPromotions : []) {
		const promo = parsePromo(entry, "promotion");
		if (promo !== void 0) promos.push(promo);
	}
	for (const entry of Array.isArray(rawTiers) ? rawTiers : []) {
		const tier = parsePromo(entry, "tier");
		if (tier !== void 0) promos.push(tier);
	}
	return promos;
}

function attachPromos(models, promos) {
	if (promos.length === 0) return [...models];
	const byModel = /* @__PURE__ */ new Map();
	for (const promo of promos) for (const modelId of promo.modelIds) {
		const list = byModel.get(modelId);
		if (list === void 0) byModel.set(modelId, [promo]);
		else list.push(promo);
	}
	return models.map((model) => {
		const list = byModel.get(model.id);
		if (list === void 0) return model;
		return {
			...model,
			promos: [...list].sort((a, b) => b.priority - a.priority)
		};
	});
}

function zonedMinutes(nowMs, timeZone) {
	const zone = timeZone ?? "UTC";
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23"
		}).formatToParts(new Date(nowMs));
		const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
		const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
		if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
		return hour * 60 + minute;
	} catch {
		return 0;
	}
}

function promoWithinAbsoluteWindow(promo, nowMs) {
	const schedule = promo.schedule;
	if (schedule === void 0) return true;
	if (schedule.validFrom !== void 0 && nowMs < schedule.validFrom) return false;
	if (schedule.validUntil !== void 0 && nowMs >= schedule.validUntil) return false;
	return true;
}

function promoWithinDailyWindow(promo, nowMs) {
	const schedule = promo.schedule;
	if (schedule === void 0) return true;
	if (schedule.dailyUnusable === true) return false;
	if (schedule.daily === void 0 || schedule.daily.length === 0) return true;
	return withinDailyWindows(schedule.daily, zonedMinutes(nowMs, schedule.timezone));
}

function promoActiveAt(promo, nowMs) {
	return promoWithinAbsoluteWindow(promo, nowMs) && promoWithinDailyWindow(promo, nowMs);
}

function hasSchedule(promo) {
	return promo.schedule !== void 0;
}

function selectPromoBadge(promos, nowMs) {
	if (promos === void 0 || promos.length === 0) return void 0;
	const sorted = [...promos].sort((a, b) => b.priority - a.priority || (a.source === b.source ? 0 : a.source === "promotion" ? -1 : 1));
	const running = sorted.find((promo) => hasSchedule(promo) && promoActiveAt(promo, nowMs));
	if (running !== void 0) return running;
	return sorted.find((promo) => promo.badge.display !== "activeOnly" && promoWithinAbsoluteWindow(promo, nowMs) && promo.schedule?.dailyUnusable !== true);
}

function minutesOfClock(value) {
	if (typeof value !== "string") return void 0;
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (match === null) return void 0;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return void 0;
	if (minutes > 59) return void 0;
	if (hours > 24) return void 0;
	if (hours === 24) return minutes === 0 ? 1440 : void 0;
	return hours * 60 + minutes;
}

function withinDailyWindows(windows, nowMinutes) {
	return windows.some((window) => {
		const start = minutesOfClock(window.start);
		const end = minutesOfClock(window.end);
		if (start === void 0 || end === void 0) return false;
		if (start === end) return true;
		if (end > start) return nowMinutes >= start && nowMinutes < end;
		return nowMinutes >= start || nowMinutes < end;
	});
}

function multiplierOfCredits(value) {
	const raw = text(value);
	if (raw === void 0) return void 0;
	const stripped = raw.replace(/x$/i, "").trim();
	if (stripped === "") return void 0;
	const parsed = Number(stripped);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}

export { parseWorkBuddyPromos, attachPromos, selectPromoBadge };
