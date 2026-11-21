'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// ============================================================================
// 1. TYPES, SCORING ENGINE & AUTO-SUB LOGIC
// ============================================================================
export function detectHatTrickFromBalls(bowlerPlayerId, balls) {
let consecutiveWickets = 0;
for (const ball of balls) {
if (ball.bowler_id !== bowlerPlayerId) {
continue;
}
const countsForBowler =
ball.is_wicket &&
ball.wicket_type !== 'RUN_OUT' &&
ball.wicket_type !== 'RETIRED_OUT' &&
ball.wicket_type !== 'OBSTRUCTING_THE_FIELD';
if (countsForBowler) {
consecutiveWickets += 1;
if (consecutiveWickets >= 3) {
return true;
}
} else {
consecutiveWickets = 0;
}
}
return false;
}
export function cricketOversToDecimal(oversBowled, ballsBowled) {
if (typeof ballsBowled === 'number' && ballsBowled > 0) {
return ballsBowled / 6;
}
const wholeOvers = Math.floor(oversBowled);
const partialBalls = Math.round((oversBowled - wholeOvers) * 10);
return wholeOvers + partialBalls / 6;
}
export function calculatePlayerMatchPoints(perf, rules) {
if (typeof perf.manual_override_points === 'number') {
return perf.manual_override_points;
}
let points = 0;
if (rules.runs_step > 0) {
points += Math.floor(perf.runs_scored / rules.runs_step) * rules.runs_step_points;
}
points += perf.fours * rules.four_points;
points += perf.sixes * rules.six_points;
if (perf.runs_scored >= 100) {
points += rules.century_points;
if (rules.stack_century_with_fifty) {
points += rules.fifty_points;
}
} else if (perf.runs_scored >= 50) {
points += rules.fifty_points;
}
if (perf.runs_scored === 0 && perf.is_out) {
points += rules.duck_points;
}
points += perf.wickets_taken * rules.wicket_points;
if (perf.has_hat_trick) {
points += rules.hat_trick_points;
}
if (perf.wickets_taken >= 5) {
points += rules.five_wicket_haul_points;
}
points += perf.maidens * rules.maiden_over_points;
points += perf.catches * rules.catch_points;
points += (perf.stumpings + perf.run_outs) * rules.stumping_or_runout_points;
const decimalOvers = cricketOversToDecimal(perf.overs_bowled, perf.balls_bowled);
if (decimalOvers >= rules.min_overs_for_economy && decimalOvers > 0) {
const economyRate = perf.runs_conceded / decimalOvers;
const matchedTier = rules.economy_tiers.find((tier) => {
const aboveMin = tier.min_er === undefined || economyRate > tier.min_er;
const withinMax = tier.max_er === undefined || economyRate <= tier.max_er;
return aboveMin && withinMax;
});
if (matchedTier) {
points += matchedTier.points;
}
}
return points;
}
function isValidPlayingXi(xi, constraints) {
if (xi.length !== constraints.playing_xi_size) {
return false;
}
let wk = 0;
let bat = 0;
let ar = 0;
let bowl = 0;
let overseas = 0;
for (const p of xi) {
if (p.role === 'WK') wk += 1;
else if (p.role === 'BAT') bat += 1;
else if (p.role === 'AR') ar += 1;
else if (p.role === 'BOWL') bowl += 1;
if (p.is_overseas) overseas += 1;
}
if (wk < constraints.xi_min_wk || wk > constraints.xi_max_wk) return false;
if (bat < constraints.xi_min_bat || bat > constraints.xi_max_bat) return false;
if (ar < constraints.xi_min_ar || ar > constraints.xi_max_ar) return false;
if (bowl < constraints.xi_min_bowl || bowl > constraints.xi_max_bowl) return false;
if (
constraints.max_overseas_xi !== null &&
overseas > constraints.max_overseas_xi
) {
return false;
}
return true;
}
export function evaluateGameweekSquad(entries, constraints, activeChip, transferPenaltyPoints) {
const xiSet = new Set(entries.filter((e) => e.is_playing_xi).map((e) => e.player_id));
const subbedOutIds = new Set();
const subbedInIds = new Set();
const benchOrdered = entries
.filter((e) => !e.is_playing_xi)
.sort((a, b) => (a.bench_priority ?? 999) - (b.bench_priority ?? 999));
for (const starter of entries.filter((e) => e.is_playing_xi)) {
if (!starter.participated) {
for (const candidate of benchOrdered) {
if (!candidate.participated || subbedInIds.has(candidate.player_id)) {
continue;
}
const candidateXi = entries.filter((p) => {
if (p.player_id === starter.player_id) return false;
if (p.player_id === candidate.player_id) return true;
return xiSet.has(p.player_id) && !subbedOutIds.has(p.player_id);
});
if (isValidPlayingXi(candidateXi, constraints)) {
xiSet.delete(starter.player_id);
xiSet.add(candidate.player_id);
subbedOutIds.add(starter.player_id);
subbedInIds.add(candidate.player_id);
break;
}
}
}
}
const captain = entries.find((e) => e.is_captain);
const viceCaptain = entries.find((e) => e.is_vice_captain);
const captainMultiplier = activeChip === 'TRIPLE_CAPTAIN' ? 3 : 2;
let effectiveSkipperId = null;
if (captain && captain.participated) {
effectiveSkipperId = captain.player_id;
} else if (viceCaptain && viceCaptain.participated) {
effectiveSkipperId = viceCaptain.player_id;
}
let rawPoints = 0;
const evaluatedPlayers = entries.map((entry) => {
const inFinalXi = xiSet.has(entry.player_id);
const countsTowardTotal = inFinalXi || activeChip === 'BENCH_BOOST';
const multiplier = entry.player_id === effectiveSkipperId ? captainMultiplier : 1;
const pointsEarned = countsTowardTotal ? entry.base_points * multiplier : 0;
if (countsTowardTotal) {
rawPoints += pointsEarned;
}
return {
...entry,
auto_subbed_in: subbedInIds.has(entry.player_id),
auto_subbed_out: subbedOutIds.has(entry.player_id),
multiplier,
points_earned: pointsEarned,
};
});
const finalPoints = rawPoints - transferPenaltyPoints;
return {
players: evaluatedPlayers,
raw_points: rawPoints,
final_points: finalPoints,
};
}
// ============================================================================
// 2. SETTINGS VALIDATION, RETENTION & AUCTION STATE MACHINE
// ============================================================================
export function validateLeagueSettings(settings) {
const errors = [];
if (settings.playing_xi_size > settings.squad_size) {
errors.push('Playing XI size cannot exceed total Squad size.');
}
const squadMinSum =
settings.squad_min_wk +
settings.squad_min_bat +
settings.squad_min_ar +
settings.squad_min_bowl;
const squadMaxSum =
settings.squad_max_wk +
settings.squad_max_bat +
settings.squad_max_ar +
settings.squad_max_bowl;
if (squadMinSum > settings.squad_size) {
errors.push('Sum of minimum squad positional limits exceeds total squad size.');
}
if (squadMaxSum < settings.squad_size) {
errors.push('Sum of maximum squad positional limits is less than total squad size.');
}
const xiMinSum =
settings.xi_min_wk + settings.xi_min_bat + settings.xi_min_ar + settings.xi_min_bowl;
const xiMaxSum =
settings.xi_max_wk + settings.xi_max_bat + settings.xi_max_ar + settings.xi_max_bowl;
if (xiMinSum > settings.playing_xi_size) {
errors.push('Sum of minimum Playing XI positional limits exceeds Playing XI size.');
}
if (xiMaxSum < settings.playing_xi_size) {
errors.push('Sum of maximum Playing XI positional limits is less than Playing XI size.');
}
for (const [label, minV, maxV] of [
['Squad WK', settings.squad_min_wk, settings.squad_max_wk],
['Squad BAT', settings.squad_min_bat, settings.squad_max_bat],
['Squad AR', settings.squad_min_ar, settings.squad_max_ar],
['Squad BOWL', settings.squad_min_bowl, settings.squad_max_bowl],
['XI WK', settings.xi_min_wk, settings.xi_max_wk],
['XI BAT', settings.xi_min_bat, settings.xi_max_bat],
['XI AR', settings.xi_min_ar, settings.xi_max_ar],
['XI BOWL', settings.xi_min_bowl, settings.xi_max_bowl],
]) {
if (minV < 0 || maxV < minV) {
errors.push(Invalid min/max bounds for ${label}.);
}
}
if (settings.starting_purse <= 0) {
errors.push('Starting purse must be greater than 0.');
}
if (settings.auction_timer_seconds < 5) {
errors.push('Auction timer must be at least 5 seconds.');
}
if (settings.max_retentions < 0 || settings.max_retentions > settings.squad_size) {
errors.push('Max retentions must be between 0 and the squad size.');
}
if (settings.max_banked_transfers < settings.free_transfers_per_gw) {
errors.push('Max banked transfers cannot be less than free transfers per Gameweek.');
}
return errors;
}
export function evaluateRetentionChoices(pastSquad, selections, settings) {
const errors = [];
const selectionMap = new Map();
for (const sel of selections) {
selectionMap.set(sel.player_id, sel.decision);
}
const retainedRaw = [];
const releasedPlayers = [];
for (const player of pastSquad) {
const decision = selectionMap.get(player.player_id) ?? 'RELEASE';
if (decision === 'RETAIN') {
retainedRaw.push(player);
} else {
releasedPlayers.push(player);
}
}
if (retainedRaw.length > settings.max_retentions) {
errors.push(
You selected ${retainedRaw.length} retentions, but the league maximum is ${settings.max_retentions}.
);
}
if (
settings.max_overseas_squad !== null &&
retainedRaw.filter((p) => p.is_overseas).length > settings.max_overseas_squad
) {
errors.push(
Retained overseas players exceed the squad overseas limit (${settings.max_overseas_squad}).
);
}
const roleCounts = { WK: 0, BAT: 0, AR: 0, BOWL: 0 };
const iplTeamCounts = new Map();
for (const p of retainedRaw) {
roleCounts[p.role] += 1;
iplTeamCounts.set(p.ipl_team, (iplTeamCounts.get(p.ipl_team) ?? 0) + 1);
}
if (roleCounts.WK > settings.squad_max_wk) {
errors.push(Retained Wicketkeepers (${roleCounts.WK}) exceed max (${settings.squad_max_wk}).);
}
if (roleCounts.BAT > settings.squad_max_bat) {
errors.push(Retained Batters (${roleCounts.BAT}) exceed max (${settings.squad_max_bat}).);
}
if (roleCounts.AR > settings.squad_max_ar) {
errors.push(Retained All-Rounders (${roleCounts.AR}) exceed max (${settings.squad_max_ar}).);
}
if (roleCounts.BOWL > settings.squad_max_bowl) {
errors.push(Retained Bowlers (${roleCounts.BOWL}) exceed max (${settings.squad_max_bowl}).);
}
if (settings.max_per_ipl_team !== null) {
for (const [team, count] of iplTeamCounts.entries()) {
if (count > settings.max_per_ipl_team) {
errors.push(
Retained players from ${team} (${count}) exceed the max per IPL team (${settings.max_per_ipl_team}).
);
}
}
}
const sortedTiers = [...settings.retention_tiers].sort((a, b) => a.slot - b.slot);
let totalDeducted = 0;
const retainedPlayers = retainedRaw.map((player, index) => {
const slot = index + 1;
let cost = 0;
if (settings.retention_mode === 'MEGA_AUCTION') {
const tier = sortedTiers.find((t) => t.slot === slot);
cost = tier ? tier.cost : sortedTiers[sortedTiers.length - 1]?.cost ?? 0;
} else {
const inflationMultiplier = 1 + settings.retention_inflation_pct / 100;
cost = Number((player.previous_price * inflationMultiplier).toFixed(2));
}
totalDeducted = Number((totalDeducted + cost).toFixed(2));
return {
...player,
retention_slot: slot,
deducted_amount: cost,
};
});
if (totalDeducted > settings.starting_purse) {
errors.push(
Total retention deduction (${totalDeducted.toFixed(2)}) exceeds starting purse (${settings.starting_purse.toFixed(2)}).
);
}
const remainingPurse = Number((settings.starting_purse - totalDeducted).toFixed(2));
const overseasRetainedCount = retainedPlayers.filter((p) => p.is_overseas).length;
return {
valid: errors.length === 0,
errors,
retained_players: retainedPlayers,
released_players: releasedPlayers,
total_deducted: totalDeducted,
remaining_purse: remainingPurse,
overseas_retained_count: overseasRetainedCount,
};
}
export function getNextBidAmount(currentBid, basePrice, increments) {
if (currentBid === null) {
return Number(basePrice.toFixed(2));
}
const sortedTiers = [...increments].sort((a, b) => {
if (a.up_to === null) return 1;
if (b.up_to === null) return -1;
return a.up_to - b.up_to;
});
const matched =
sortedTiers.find((tier) => tier.up_to === null || currentBid < tier.up_to) ??
sortedTiers[sortedTiers.length - 1];
const step = matched ? matched.step : 0.25;
return Number((currentBid + step).toFixed(2));
}
export function canManagerAcquirePlayer(
manager,
player,
bidAmount,
settings,
minBasePriceReserve = 0.5
) {
const openSlots = settings.squad_size - manager.squad.length;
if (openSlots <= 0) {
return { allowed: false, reason: 'Squad is already full.' };
}
const minReserveNeeded = Math.max(0, (openSlots - 1) * minBasePriceReserve);
if (manager.purse_remaining - bidAmount < minReserveNeeded) {
return {
allowed: false,
reason: Insufficient purse (must reserve at least ₹${minReserveNeeded.toFixed(2)} Cr for remaining slots).,
};
}
if (
settings.max_overseas_squad !== null &&
player.is_overseas &&
manager.squad.filter((p) => p.is_overseas).length >= settings.max_overseas_squad
) {
return {
allowed: false,
reason: Overseas squad limit (${settings.max_overseas_squad}) reached.,
};
}
if (settings.max_per_ipl_team !== null) {
const teamCount = manager.squad.filter((p) => p.ipl_team === player.ipl_team).length;
if (teamCount >= settings.max_per_ipl_team) {
return {
allowed: false,
reason: Max players from ${player.ipl_team} (${settings.max_per_ipl_team}) reached.,
};
}
}
const roleCount = manager.squad.filter((p) => p.role === player.role).length;
const roleMaxMap = {
WK: settings.squad_max_wk,
BAT: settings.squad_max_bat,
AR: settings.squad_max_ar,
BOWL: settings.squad_max_bowl,
};
if (roleCount >= roleMaxMap[player.role]) {
return {
allowed: false,
reason: Max ${player.role} limit (${roleMaxMap[player.role]}) reached.,
};
}
const nextSquad = [
...manager.squad,
{
player_id: player.player_id,
role: player.role,
ipl_team: player.ipl_team,
is_overseas: player.is_overseas,
price: bidAmount,
},
];
const slotsAfter = settings.squad_size - nextSquad.length;
const minNeeded = {
WK: Math.max(0, settings.squad_min_wk - nextSquad.filter((p) => p.role === 'WK').length),
BAT: Math.max(0, settings.squad_min_bat - nextSquad.filter((p) => p.role === 'BAT').length),
AR: Math.max(0, settings.squad_min_ar - nextSquad.filter((p) => p.role === 'AR').length),
BOWL: Math.max(0, settings.squad_min_bowl - nextSquad.filter((p) => p.role === 'BOWL').length),
};
const totalMandatoryLeft =
minNeeded.WK + minNeeded.BAT + minNeeded.AR + minNeeded.BOWL;
if (totalMandatoryLeft > slotsAfter) {
return {
allowed: false,
reason: 'Acquiring this player leaves too few slots to meet minimum positional requirements.',
};
}
return { allowed: true };
}
export function applyBid(
state,
memberId,
amount,
settings,
increments,
nowIso = new Date().toISOString()
) {
if (state.status !== 'LIVE' || !state.current_player) {
return { ok: false, error: 'Auction is not currently accepting bids.', nextState: state };
}
if (state.awaiting_rtm || state.awaiting_rtm_counter) {
return { ok: false, error: 'Waiting for Right to Match (RTM) resolution.', nextState: state };
}
if (state.current_highest_bidder_id === memberId) {
return { ok: false, error: 'You are already the highest bidder.', nextState: state };
}
const manager = state.managers[memberId];
if (!manager) {
return { ok: false, error: 'Manager not found in auction.', nextState: state };
}
const expectedMinBid = getNextBidAmount(
state.current_bid_amount,
state.current_player.base_price,
increments
);
if (amount < expectedMinBid) {
return {
ok: false,
error: Minimum valid bid is ₹${expectedMinBid.toFixed(2)} Cr.,
nextState: state,
};
}
const eligibility = canManagerAcquirePlayer(manager, state.current_player, amount, settings);
if (!eligibility.allowed) {
return { ok: false, error: eligibility.reason, nextState: state };
}
const expiresAt = new Date(
Date.parse(nowIso) + settings.auction_timer_seconds * 1000
).toISOString();
const nextState = {
...state,
current_bid_amount: Number(amount.toFixed(2)),
current_highest_bidder_id: memberId,
timer_expires_at: expiresAt,
activity_feed: [
{
id: ${Date.now()}-${memberId},
message: ${manager.team_name} bid ₹${amount.toFixed(2)} Cr for ${state.current_player.full_name},
timestamp: nowIso,
},
...state.activity_feed.slice(0, 49),
],
};
return { ok: true, nextState };
}
function finalizePlayerSale(state, winnerMemberId, price, nowIso, usedRtm = false) {
const player = state.current_player;
const winner = state.managers[winnerMemberId];
const updatedWinner = {
...winner,
purse_remaining: Number((winner.purse_remaining - price).toFixed(2)),
rtm_cards_remaining: usedRtm
? Math.max(0, winner.rtm_cards_remaining - 1)
: winner.rtm_cards_remaining,
squad: [
...winner.squad,
{
player_id: player.player_id,
role: player.role,
ipl_team: player.ipl_team,
is_overseas: player.is_overseas,
price,
},
],
};
return {
outcome: 'SOLD',
soldToMemberId: winnerMemberId,
soldPrice: price,
nextState: {
...state,
managers: {
...state.managers,
[winnerMemberId]: updatedWinner,
},
awaiting_rtm: false,
awaiting_rtm_counter: false,
timer_expires_at: null,
activity_feed: [
{
id: ${Date.now()}-sold,
message: SOLD! ${player.full_name} to ${winner.team_name} for ₹${price.toFixed(2)} Cr${usedRtm ? ' (via RTM)' : ''}.,
timestamp: nowIso,
},
...state.activity_feed.slice(0, 49),
],
},
};
}
export function handleRtmAction(state, action, settings, nowIso = new Date().toISOString()) {
const player = state.current_player;
if (!player || state.current_bid_amount === null || !state.current_highest_bidder_id) {
return { ok: false, error: 'No active player for RTM.', nextState: state };
}
const formerOwnerId = player.former_owner_member_id;
const highestBidderId = state.current_highest_bidder_id;
const currentBid = state.current_bid_amount;
if (action.type === 'DECLINE_RTM') {
if (!state.awaiting_rtm || action.member_id !== formerOwnerId) {
return { ok: false, error: 'Not authorized to decline RTM.', nextState: state };
}
const { nextState } = finalizePlayerSale(state, highestBidderId, currentBid, nowIso);
return { ok: true, nextState };
}
if (action.type === 'USE_RTM') {
if (!state.awaiting_rtm || action.member_id !== formerOwnerId) {
return { ok: false, error: 'Not authorized to exercise RTM.', nextState: state };
}
const highestBidder = state.managers[highestBidderId];
const canCounter =
highestBidder &&
canManagerAcquirePlayer(highestBidder, player, currentBid + 0.25, settings).allowed;
if (!canCounter) {
const { nextState } = finalizePlayerSale(state, formerOwnerId, currentBid, nowIso, true);
return { ok: true, nextState };
}
const counterExpires = new Date(
Date.parse(nowIso) + settings.auction_timer_seconds * 1000
).toISOString();
return {
ok: true,
nextState: {
...state,
awaiting_rtm: false,
awaiting_rtm_counter: true,
timer_expires_at: counterExpires,
activity_feed: [
{
id: ${Date.now()}-rtm-used,
message: ${state.managers[formerOwnerId].team_name} invoked RTM! ${highestBidder.team_name} has one final raise.,
timestamp: nowIso,
},
...state.activity_feed.slice(0, 49),
],
},
};
}
if (action.type === 'SKIP_COUNTER') {
if (!state.awaiting_rtm_counter || action.member_id !== highestBidderId || !formerOwnerId) {
return { ok: false, error: 'Not authorized to skip counter-raise.', nextState: state };
}
const { nextState } = finalizePlayerSale(state, formerOwnerId, currentBid, nowIso, true);
return { ok: true, nextState };
}
if (action.type === 'COUNTER_RAISE') {
if (!state.awaiting_rtm_counter || action.member_id !== highestBidderId || !formerOwnerId) {
return { ok: false, error: 'Not authorized to counter-raise.', nextState: state };
}
if (action.new_amount <= currentBid) {
return {
ok: false,
error: Counter-raise must exceed ₹${currentBid.toFixed(2)} Cr.,
nextState: state,
};
}
const highestBidder = state.managers[highestBidderId];
const check = canManagerAcquirePlayer(highestBidder, player, action.new_amount, settings);
if (!check.allowed) {
return { ok: false, error: check.reason, nextState: state };
}
return {
ok: true,
nextState: {
...state,
current_bid_amount: Number(action.new_amount.toFixed(2)),
awaiting_rtm_counter: false,
awaiting_rtm: true,
timer_expires_at: new Date(
Date.parse(nowIso) + settings.auction_timer_seconds * 1000
).toISOString(),
activity_feed: [
{
id: ${Date.now()}-rtm-counter,
message: ${highestBidder.team_name} counter-raised to ₹${action.new_amount.toFixed(2)} Cr!,
timestamp: nowIso,
},
...state.activity_feed.slice(0, 49),
],
},
};
}
if (action.type === 'CONFIRM_FINAL_RTM') {
if (!state.awaiting_rtm || action.member_id !== formerOwnerId) {
return { ok: false, error: 'Not authorized to confirm final RTM.', nextState: state };
}
if (action.accept) {
const { nextState } = finalizePlayerSale(state, formerOwnerId, currentBid, nowIso, true);
return { ok: true, nextState };
} else {
const { nextState } = finalizePlayerSale(state, highestBidderId, currentBid, nowIso, false);
return { ok: true, nextState };
}
}
return { ok: false, error: 'Unsupported RTM action.', nextState: state };
}
export function syncAuctionIntoSnapshot(snapshot, nextAuction) {
const nextPurses = { ...snapshot.purses_by_member };
for (const [memberId, mgrState] of Object.entries(nextAuction.managers)) {
nextPurses[memberId] = mgrState.purse_remaining;
}
return {
...snapshot,
updated_at: new Date().toISOString(),
auction: nextAuction,
purses_by_member: nextPurses,
};
}
// ============================================================================
// 3. DEFAULT DATA & MULTIPLAYER SYNC CHANNEL
// ============================================================================
const DEFAULT_LEAGUE_SETTINGS = {
squad_size: 15,
playing_xi_size: 11,
squad_min_wk: 1,
squad_max_wk: 4,
squad_min_bat: 3,
squad_max_bat: 6,
squad_min_ar: 1,
squad_max_ar: 4,
squad_min_bowl: 3,
squad_max_bowl: 6,
xi_min_wk: 1,
xi_max_wk: 4,
xi_min_bat: 3,
xi_max_bat: 6,
xi_min_ar: 1,
xi_max_ar: 4,
xi_min_bowl: 3,
xi_max_bowl: 6,
max_overseas_xi: 4,
max_overseas_squad: 8,
max_per_ipl_team: 4,
starting_purse: 100.0,
auction_timer_seconds: 15,
rtm_enabled: true,
rtm_cards_per_manager: 2,
retention_mode: 'MEGA_AUCTION',
max_retentions: 6,
retention_tiers: [
{ slot: 1, cost: 18.0 },
{ slot: 2, cost: 14.0 },
{ slot: 3, cost: 11.0 },
{ slot: 4, cost: 18.0 },
{ slot: 5, cost: 14.0 },
{ slot: 6, cost: 4.0 },
],
retention_inflation_pct: 0.0,
free_transfers_per_gw: 1,
max_banked_transfers: 2,
transfer_hit_penalty: 4,
chip_sets_per_season: 1,
enable_triple_captain: true,
enable_bench_boost: true,
enable_wildcard: true,
enable_free_hit: true,
deadline_minutes_before_first_match: 60,
};
const DEFAULT_BID_INCREMENTS = [
{ up_to: 5.0, step: 0.25 },
{ up_to: 20.0, step: 0.5 },
{ up_to: null, step: 1.0 },
];
const DEFAULT_SCORING_RULES = {
runs_step: 10,
runs_step_points: 1,
four_points: 1,
six_points: 2,
fifty_points: 5,
century_points: 10,
stack_century_with_fifty: false,
duck_points: -5,
wicket_points: 5,
hat_trick_points: 30,
five_wicket_haul_points: 35,
maiden_over_points: 5,
catch_points: 3,
stumping_or_runout_points: 5,
min_overs_for_economy: 2.0,
economy_tiers: [
{ label: 'Elite', max_er: 5.0, points: 10 },
{ label: 'Great', min_er: 5.0, max_er: 7.0, points: 7 },
{ label: 'Disciplined', min_er: 7.1, max_er: 9.0, points: 3 },
{ label: 'Average', min_er: 9.1, max_er: 11.0, points: 1 },
{ label: 'Costly', min_er: 11.1, max_er: 13.0, points: -3 },
{ label: 'Expensive', min_er: 13.1, max_er: 15.0, points: -5 },
{ label: 'Poor', min_er: 15.01, points: -10 },
],
};
const INITIAL_PAST_ROSTER = [
{
player_id: 'p1',
full_name: 'Virat Kohli',
role: 'BAT',
ipl_team: 'RCB',
is_overseas: false,
previous_price: 17.0,
is_uncapped: false,
},
{
player_id: 'p2',
full_name: 'Jasprit Bumrah',
role: 'BOWL',
ipl_team: 'MI',
is_overseas: false,
previous_price: 18.0,
is_uncapped: false,
},
{
player_id: 'p3',
full_name: 'Hardik Pandya',
role: 'AR',
ipl_team: 'MI',
is_overseas: false,
previous_price: 15.0,
is_uncapped: false,
},
{
player_id: 'p4',
full_name: 'Rishabh Pant',
role: 'WK',
ipl_team: 'LSG',
is_overseas: false,
previous_price: 16.0,
is_uncapped: false,
},
{
player_id: 'p5',
full_name: 'Glenn Maxwell',
role: 'AR',
ipl_team: 'PBKS',
is_overseas: true,
previous_price: 11.0,
is_uncapped: false,
},
];
const CATALOG_PLAYERS = [
...INITIAL_PAST_ROSTER,
{
player_id: 'p6',
full_name: 'Heinrich Klaasen',
role: 'WK',
ipl_team: 'SRH',
is_overseas: true,
previous_price: 14.0,
is_uncapped: false,
},
{
player_id: 'p7',
full_name: 'Rashid Khan',
role: 'BOWL',
ipl_team: 'GT',
is_overseas: true,
previous_price: 15.0,
is_uncapped: false,
},
{
player_id: 'p8',
full_name: 'Yashasvi Jaiswal',
role: 'BAT',
ipl_team: 'RR',
is_overseas: false,
previous_price: 12.0,
is_uncapped: false,
},
{
player_id: 'p9',
full_name: 'Axar Patel',
role: 'AR',
ipl_team: 'DC',
is_overseas: false,
previous_price: 10.5,
is_uncapped: false,
},
{
player_id: 'p10',
full_name: 'Pat Cummins',
role: 'BOWL',
ipl_team: 'SRH',
is_overseas: true,
previous_price: 13.5,
is_uncapped: false,
},
];
const INITIAL_AUCTION_STATE = {
auction_id: 'auc-1',
league_id: 'lg-1',
status: 'LIVE',
round_type: 'MAIN',
current_player: {
player_id: 'p7',
full_name: 'Rashid Khan',
role: 'BOWL',
ipl_team: 'GT',
is_overseas: true,
base_price: 2.0,
set_category: 'MARQUEE',
former_owner_member_id: 'm2',
},
current_bid_amount: 6.0,
current_highest_bidder_id: 'm1',
awaiting_rtm: false,
awaiting_rtm_counter: false,
timer_expires_at: new Date(Date.now() + 30000).toISOString(),
managers: {
m1: {
member_id: 'm1',
team_name: 'Royal Challengers XI',
purse_remaining: 65.0,
rtm_cards_remaining: 2,
squad: [
{ player_id: 'p1', role: 'BAT', ipl_team: 'RCB', is_overseas: false, price: 18.0 },
{ player_id: 'p2', role: 'BOWL', ipl_team: 'MI', is_overseas: false, price: 14.0 },
],
},
m2: {
member_id: 'm2',
team_name: 'Super Kings United',
purse_remaining: 72.0,
rtm_cards_remaining: 2,
squad: [
{ player_id: 'p3', role: 'AR', ipl_team: 'MI', is_overseas: false, price: 18.0 },
{ player_id: 'p4', role: 'WK', ipl_team: 'LSG', is_overseas: false, price: 14.0 },
],
},
},
queue_remaining_count: 4,
unsold_count: 1,
activity_feed: [
{
id: 'init-1',
message: 'Royal Challengers XI bid ₹6.00 Cr for Rashid Khan',
timestamp: new Date().toISOString(),
},
],
};
const INITIAL_SQUAD = [
{
player_id: 'p1',
full_name: 'Virat Kohli',
role: 'BAT',
ipl_team: 'RCB',
is_overseas: false,
is_playing_xi: true,
bench_priority: null,
is_captain: true,
is_vice_captain: false,
gw_points: 24,
form_rating: 8.4,
ownership_pct: 68.5,
market_price: 17.5,
next_fixture: 'vs CSK (H)',
},
{
player_id: 'p2',
full_name: 'Jasprit Bumrah',
role: 'BOWL',
ipl_team: 'MI',
is_overseas: false,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: true,
gw_points: 18,
form_rating: 9.1,
ownership_pct: 74.0,
market_price: 18.0,
next_fixture: 'vs KKR (A)',
},
{
player_id: 'p3',
full_name: 'Hardik Pandya',
role: 'AR',
ipl_team: 'MI',
is_overseas: false,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: false,
gw_points: 12,
form_rating: 6.8,
ownership_pct: 51.2,
market_price: 15.0,
next_fixture: 'vs KKR (A)',
},
{
player_id: 'p4',
full_name: 'Rishabh Pant',
role: 'WK',
ipl_team: 'LSG',
is_overseas: false,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: false,
gw_points: 15,
form_rating: 7.5,
ownership_pct: 44.0,
market_price: 15.5,
next_fixture: 'vs DC (H)',
},
{
player_id: 'p8',
full_name: 'Yashasvi Jaiswal',
role: 'BAT',
ipl_team: 'RR',
is_overseas: false,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: false,
gw_points: 11,
form_rating: 7.2,
ownership_pct: 49.8,
market_price: 12.5,
next_fixture: 'vs SRH (H)',
},
{
player_id: 'p9',
full_name: 'Axar Patel',
role: 'AR',
ipl_team: 'DC',
is_overseas: false,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: false,
gw_points: 9,
form_rating: 6.5,
ownership_pct: 38.0,
market_price: 11.0,
next_fixture: 'vs LSG (A)',
},
{
player_id: 'p7',
full_name: 'Rashid Khan',
role: 'BOWL',
ipl_team: 'GT',
is_overseas: true,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: false,
gw_points: 16,
form_rating: 8.2,
ownership_pct: 61.4,
market_price: 15.0,
next_fixture: 'vs PBKS (H)',
},
{
player_id: 'p10',
full_name: 'Pat Cummins',
role: 'BOWL',
ipl_team: 'SRH',
is_overseas: true,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: false,
gw_points: 10,
form_rating: 6.9,
ownership_pct: 42.3,
market_price: 13.0,
next_fixture: 'vs RR (A)',
},
{
player_id: 'p6',
full_name: 'Heinrich Klaasen',
role: 'WK',
ipl_team: 'SRH',
is_overseas: true,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: false,
gw_points: 21,
form_rating: 8.7,
ownership_pct: 57.9,
market_price: 14.5,
next_fixture: 'vs RR (A)',
},
{
player_id: 'p5',
full_name: 'Glenn Maxwell',
role: 'AR',
ipl_team: 'PBKS',
is_overseas: true,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: false,
gw_points: 6,
form_rating: 5.4,
ownership_pct: 29.1,
market_price: 10.5,
next_fixture: 'vs GT (A)',
},
{
player_id: 'p11',
full_name: 'Suryakumar Yadav',
role: 'BAT',
ipl_team: 'MI',
is_overseas: false,
is_playing_xi: true,
bench_priority: null,
is_captain: false,
is_vice_captain: false,
gw_points: 14,
form_rating: 7.8,
ownership_pct: 53.6,
market_price: 16.0,
next_fixture: 'vs KKR (A)',
},
{
player_id: 'p12',
full_name: 'Yuzvendra Chahal',
role: 'BOWL',
ipl_team: 'PBKS',
is_overseas: false,
is_playing_xi: false,
bench_priority: 1,
is_captain: false,
is_vice_captain: false,
gw_points: 12,
form_rating: 7.1,
ownership_pct: 36.2,
market_price: 11.5,
next_fixture: 'vs GT (A)',
},
{
player_id: 'p13',
full_name: 'Shubman Gill',
role: 'BAT',
ipl_team: 'GT',
is_overseas: false,
is_playing_xi: false,
bench_priority: 2,
is_captain: false,
is_vice_captain: false,
gw_points: 8,
form_rating: 6.7,
ownership_pct: 47.0,
market_price: 14.0,
next_fixture: 'vs PBKS (H)',
},
{
player_id: 'p14',
full_name: 'Ravindra Jadeja',
role: 'AR',
ipl_team: 'CSK',
is_overseas: false,
is_playing_xi: false,
bench_priority: 3,
is_captain: false,
is_vice_captain: false,
gw_points: 7,
form_rating: 6.4,
ownership_pct: 41.5,
market_price: 13.5,
next_fixture: 'vs RCB (A)',
},
{
player_id: 'p15',
full_name: 'Sanju Samson',
role: 'WK',
ipl_team: 'RR',
is_overseas: false,
is_playing_xi: false,
bench_priority: 4,
is_captain: false,
is_vice_captain: false,
gw_points: 5,
form_rating: 6.1,
ownership_pct: 33.8,
market_price: 12.0,
next_fixture: 'vs SRH (H)',
},
];
const INITIAL_MARKET_POOL = [
{
player_id: 'fa1',
full_name: 'Trent Boult',
role: 'BOWL',
ipl_team: 'MI',
is_overseas: true,
market_price: 9.0,
form_rating: 7.3,
ownership_pct: 22.0,
is_owned: false,
},
{
player_id: 'fa2',
full_name: 'Ruturaj Gaikwad',
role: 'BAT',
ipl_team: 'CSK',
is_overseas: false,
market_price: 11.5,
form_rating: 7.6,
ownership_pct: 31.4,
is_owned: true,
owner_team_name: 'Super Kings United',
},
];
const INITIAL_STANDINGS = [
{
member_id: 'm1',
team_name: 'Royal Challengers XI',
manager_name: 'Aarav',
current_rank: 1,
previous_rank: 2,
gw_points: 165,
gw_by_number: { 1: 142, 2: 165 },
month_key: '2026-11',
total_points: 307,
},
{
member_id: 'm2',
team_name: 'Super Kings United',
manager_name: 'Vikram',
current_rank: 2,
previous_rank: 1,
gw_points: 148,
gw_by_number: { 1: 151, 2: 148 },
month_key: '2026-11',
total_points: 299,
},
];
const SHARED_LEAGUE_CHANNEL = 'fantasy-ipl-shared-league-v2';
const LEAGUE_API_ENDPOINT = '/api/league/state';
function createSharedLeagueChannel(onRemoteSnapshot) {
const bc =
typeof window !== 'undefined' && 'BroadcastChannel' in window
? new BroadcastChannel(SHARED_LEAGUE_CHANNEL)
: null;
if (bc) {
bc.onmessage = (event) => {
if (event.data?.type === 'SNAPSHOT_UPDATED' && event.data.snapshot) {
onRemoteSnapshot(event.data.snapshot);
}
};
}
return {
publishSnapshot(snapshot) {
bc?.postMessage({ type: 'SNAPSHOT_UPDATED', snapshot });
},
close() {
bc?.close();
},
};
}
async function fetchRemoteLeagueSnapshot(leagueId) {
const url = ${LEAGUE_API_ENDPOINT}?leagueId=${encodeURIComponent(leagueId)};
const res = await fetch(url, { cache: 'no-store' });
if (!res.ok) {
throw new Error(Failed to load league state (${res.status}));
}
return res.json();
}
async function pushRemoteLeagueSnapshot(snapshot) {
const res = await fetch(LEAGUE_API_ENDPOINT, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(snapshot),
});
if (!res.ok) {
throw new Error(Failed to save league state (${res.status}));
}
return res.json();
}
const FALLBACK_SNAPSHOT = {
league_id: 'lg-1',
invite_code: 'IPL-LIVE-2026',
updated_at: new Date().toISOString(),
settings: DEFAULT_LEAGUE_SETTINGS,
scoring_rules: DEFAULT_SCORING_RULES,
managers: [
{
member_id: 'm1',
user_id: 'u1',
display_name: 'Aarav',
team_name: 'Royal Challengers XI',
is_commissioner: true,
},
{
member_id: 'm2',
user_id: 'u2',
display_name: 'Vikram',
team_name: 'Super Kings United',
is_commissioner: false,
},
],
auction: INITIAL_AUCTION_STATE,
standings: INITIAL_STANDINGS,
past_rosters_by_member: {
m1: INITIAL_PAST_ROSTER,
m2: INITIAL_PAST_ROSTER.slice(1),
},
squads_by_member: {
m1: INITIAL_SQUAD,
m2: INITIAL_SQUAD.map((p) => ({
...p,
is_captain: p.player_id === 'p2',
is_vice_captain: p.player_id === 'p1',
})),
},
purses_by_member: {
m1: 65.0,
m2: 72.0,
},
free_transfers_by_member: {
m1: DEFAULT_LEAGUE_SETTINGS.free_transfers_per_gw,
m2: DEFAULT_LEAGUE_SETTINGS.free_transfers_per_gw,
},
};
// ============================================================================
// 4. SUB-COMPONENTS
// ============================================================================
function ManagerSessionBar({
inviteCode,
managers,
activeMemberId,
onSwitchManager,
onAddManager,
}) {
const [newName, setNewName] = useState('');
const [newTeam, setNewTeam] = useState('');
function handleJoin(e) {
e.preventDefault();
if (!newName.trim() || !newTeam.trim()) return;
onAddManager(newName.trim(), newTeam.trim());
setNewName('');
setNewTeam('');
}
return (
<div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-xs">
<div className="flex flex-wrap items-center gap-3">
<span className="rounded bg-emerald-500/20 px-2.5 py-1 font-bold text-emerald-300">
League Code: {inviteCode}
</span>
<label className="flex items-center gap-2 text-slate-300">
<span className="text-slate-400">Your Personal Team View:</span>
<select
value={activeMemberId}
onChange={(e) => onSwitchManager(e.target.value)}
className="rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-semibold text-white"
>
{managers.map((m) => (
<option key={m.member_id} value={m.member_id}>
{m.team_name} ({m.display_name}){m.is_commissioner ? ' • Admin' : ''}
</option>
))}
</select>
</label>
</div>
<form onSubmit={handleJoin} className="flex flex-wrap items-center gap-2">
<input
type="text"
placeholder="Manager name"
value={newName}
onChange={(e) => setNewName(e.target.value)}
className="w-28 rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-white"
/>
<input
type="text"
placeholder="Team name"
value={newTeam}
onChange={(e) => setNewTeam(e.target.value)}
className="w-36 rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-white"
/>
<button
type="submit"
className="rounded bg-emerald-500 px-3 py-1 font-bold text-slate-950 hover:bg-emerald-400"
>
+ Join League
</button>
</form>
</div>
);
}
function LeagueSettingsConfigurator({ initialSettings, onSave }) {
const [form, setForm] = useState(initialSettings);
const [errors, setErrors] = useState([]);
const [savedNotice, setSavedNotice] = useState(null);
const [saving, setSaving] = useState(false);
useEffect(() => {
setForm(initialSettings);
}, [initialSettings]);
function updateField(key, value) {
setSavedNotice(null);
setForm((prev) => ({ ...prev, [key]: value }));
}
function handleTierCostChange(index, newCost) {
setSavedNotice(null);
setForm((prev) => {
const nextTiers = prev.retention_tiers.map((tier, idx) =>
idx === index ? { ...tier, cost: Number.isNaN(newCost) ? 0 : newCost } : tier
);
return { ...prev, retention_tiers: nextTiers };
});
}
async function handleSubmit(e) {
e.preventDefault();
setSavedNotice(null);
const validationErrors = validateLeagueSettings(form);
if (validationErrors.length > 0) {
setErrors(validationErrors);
return;
}
setErrors([]);
setSaving(true);
try {
await onSave(form);
setSavedNotice('League settings saved.');
} finally {
setSaving(false);
}
}
return (
<form
onSubmit={handleSubmit}
className="space-y-8 rounded-xl border border-slate-800 bg-slate-950 p-6 text-slate-100"
>
<div className="flex items-center justify-between border-b border-slate-800 pb-4">
<div>
<h2 className="text-xl font-bold">League Settings Configurator</h2>
<p className="text-sm text-slate-400">
Configure squad limits, retention rules, auction purse, transfers, and chips.
</p>
</div>
<button
type="submit"
disabled={saving}
className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
>
{saving ? 'Saving...' : 'Save Settings'}
</button>
</div>
{errors.length > 0 && (
<div className="rounded-lg border border-red-500/50 bg-red-950/40 p-4 text-sm text-red-200">
<p className="font-semibold">Please fix the following issues:</p>
<ul className="mt-1 list-disc pl-5 space-y-1">
{errors.map((err, i) => (
<li key={i}>{err}</li>
))}
</ul>
</div>
)}
{savedNotice && (
<div className="rounded-lg border border-emerald-500/50 bg-emerald-950/40 p-3 text-sm text-emerald-200">
{savedNotice}
</div>
)}
<section className="space-y-4">
<h3 className="text-base font-semibold text-emerald-400">Squad, Playing XI & Caps</h3>
<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
<label className="space-y-1 text-xs">
<span className="text-slate-400">Total Squad Size</span>
<input
type="number"
min={11}
max={25}
value={form.squad_size}
onChange={(e) => updateField('squad_size', Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
<label className="space-y-1 text-xs">
<span className="text-slate-400">Playing XI Size</span>
<input
type="number"
min={5}
max={15}
value={form.playing_xi_size}
onChange={(e) => updateField('playing_xi_size', Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
<label className="space-y-1 text-xs">
<span className="text-slate-400">Max Overseas XI (blank = ∞)</span>
<input
type="number"
min={0}
value={form.max_overseas_xi ?? ''}
onChange={(e) =>
updateField(
'max_overseas_xi',
e.target.value === '' ? null : Number(e.target.value)
)
}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
<label className="space-y-1 text-xs">
<span className="text-slate-400">Max Per IPL Team (blank = ∞)</span>
<input
type="number"
min={1}
value={form.max_per_ipl_team ?? ''}
onChange={(e) =>
updateField(
'max_per_ipl_team',
e.target.value === '' ? null : Number(e.target.value)
)
}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
</div>
<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
<div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 space-y-3">
<p className="text-xs font-semibold uppercase tracking-wider text-slate-300">
Full Squad Positional Bounds (Min / Max)
</p>
{[
['WK', 'squad_min_wk', 'squad_max_wk'],
['BAT', 'squad_min_bat', 'squad_max_bat'],
['AR', 'squad_min_ar', 'squad_max_ar'],
['BOWL', 'squad_min_bowl', 'squad_max_bowl'],
].map(([role, minKey, maxKey]) => (
<div key={role} className="grid grid-cols-3 items-center gap-2 text-xs">
<span className="font-semibold">{role}</span>
<input
type="number"
min={0}
value={form[minKey]}
onChange={(e) => updateField(minKey, Number(e.target.value))}
aria-label={${role} Squad Min}
className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
/>
<input
type="number"
min={0}
value={form[maxKey]}
onChange={(e) => updateField(maxKey, Number(e.target.value))}
aria-label={${role} Squad Max}
className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
/>
</div>
))}
</div>
<div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 space-y-3">
<p className="text-xs font-semibold uppercase tracking-wider text-slate-300">
Playing XI Positional Bounds (Min / Max)
</p>
{[
['WK', 'xi_min_wk', 'xi_max_wk'],
['BAT', 'xi_min_bat', 'xi_max_bat'],
['AR', 'xi_min_ar', 'xi_max_ar'],
['BOWL', 'xi_min_bowl', 'xi_max_bowl'],
].map(([role, minKey, maxKey]) => (
<div key={role} className="grid grid-cols-3 items-center gap-2 text-xs">
<span className="font-semibold">{role}</span>
<input
type="number"
min={0}
value={form[minKey]}
onChange={(e) => updateField(minKey, Number(e.target.value))}
aria-label={${role} XI Min}
className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
/>
<input
type="number"
min={0}
value={form[maxKey]}
onChange={(e) => updateField(maxKey, Number(e.target.value))}
aria-label={${role} XI Max}
className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
/>
</div>
))}
</div>
</div>
</section>
<section className="space-y-4">
<h3 className="text-base font-semibold text-emerald-400">Purse, Retention & RTM</h3>
<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
<label className="space-y-1 text-xs">
<span className="text-slate-400">Starting Purse</span>
<input
type="number"
step="0.5"
value={form.starting_purse}
onChange={(e) => updateField('starting_purse', Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
<label className="space-y-1 text-xs">
<span className="text-slate-400">Retention Mode</span>
<select
value={form.retention_mode}
onChange={(e) => updateField('retention_mode', e.target.value)}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
>
<option value="MEGA_AUCTION">Mega-Auction (Tiered)</option>
<option value="MINI_AUCTION">Mini-Auction / Keeper</option>
</select>
</label>
<label className="space-y-1 text-xs">
<span className="text-slate-400">Max Retentions</span>
<input
type="number"
min={0}
max={form.squad_size}
value={form.max_retentions}
onChange={(e) => updateField('max_retentions', Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
<label className="space-y-1 text-xs">
<span className="text-slate-400">Bid Timer (Seconds)</span>
<input
type="number"
min={5}
value={form.auction_timer_seconds}
onChange={(e) => updateField('auction_timer_seconds', Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
</div>
{form.retention_mode === 'MEGA_AUCTION' ? (
<div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
<p className="mb-2 text-xs font-semibold text-slate-300">
Retention Slot Deduction Tiers
</p>
<div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
{form.retention_tiers.map((tier, idx) => (
<label key={tier.slot} className="space-y-1 text-xs">
<span className="text-slate-400">Slot #{tier.slot}</span>
<input
type="number"
step="0.5"
value={tier.cost}
onChange={(e) => handleTierCostChange(idx, Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
/>
</label>
))}
</div>
</div>
) : (
<div className="max-w-xs">
<label className="space-y-1 text-xs">
<span className="text-slate-400">Keeper Inflation % (on prior price)</span>
<input
type="number"
step="1"
value={form.retention_inflation_pct}
onChange={(e) => updateField('retention_inflation_pct', Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
</div>
)}
<div className="flex flex-wrap gap-6 text-xs">
<label className="flex items-center gap-2">
<input
type="checkbox"
checked={form.rtm_enabled}
onChange={(e) => updateField('rtm_enabled', e.target.checked)}
/>
<span>Enable Right to Match (RTM) Cards</span>
</label>
{form.rtm_enabled && (
<label className="flex items-center gap-2">
<span className="text-slate-400">RTM Cards per Manager:</span>
<input
type="number"
min={0}
value={form.rtm_cards_per_manager}
onChange={(e) => updateField('rtm_cards_per_manager', Number(e.target.value))}
className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1"
/>
</label>
)}
</div>
</section>
<section className="space-y-4">
<h3 className="text-base font-semibold text-emerald-400">Weekly Transfers & Chips</h3>
<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
<label className="space-y-1 text-xs">
<span className="text-slate-400">Free Transfers / GW</span>
<input
type="number"
min={0}
value={form.free_transfers_per_gw}
onChange={(e) => updateField('free_transfers_per_gw', Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
<label className="space-y-1 text-xs">
<span className="text-slate-400">Max Banked Transfers</span>
<input
type="number"
min={0}
value={form.max_banked_transfers}
onChange={(e) => updateField('max_banked_transfers', Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
<label className="space-y-1 text-xs">
<span className="text-slate-400">Transfer Hit Penalty (pts)</span>
<input
type="number"
min={0}
value={form.transfer_hit_penalty}
onChange={(e) => updateField('transfer_hit_penalty', Number(e.target.value))}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
/>
</label>
<label className="space-y-1 text-xs">
<span className="text-slate-400">Chip Sets / Season</span>
<select
value={form.chip_sets_per_season}
onChange={(e) =>
updateField('chip_sets_per_season', Number(e.target.value))
}
className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
>
<option value={1}>1 Set per Season</option>
<option value={2}>2 Sets (First / Second Half)</option>
</select>
</label>
</div>
<div className="flex flex-wrap gap-6 text-xs">
{[
['Triple Captain', 'enable_triple_captain'],
['Bench Boost', 'enable_bench_boost'],
['Wildcard', 'enable_wildcard'],
['Free Hit', 'enable_free_hit'],
].map(([label, key]) => (
<label key={key} className="flex items-center gap-2">
<input
type="checkbox"
checked={Boolean(form[key])}
onChange={(e) => updateField(key, e.target.checked)}
/>
<span>{label}</span>
</label>
))}
</div>
</section>
</form>
);
}
function RetentionWarRoom({
teamName,
settings,
initialPastRoster,
availablePlayersCatalog,
onImportRoster,
onConfirmRetentions,
}) {
const [pastRoster, setPastRoster] = useState(initialPastRoster);
const [searchQuery, setSearchQuery] = useState('');
const [decisions, setDecisions] = useState(() => {
const map = {};
for (const p of initialPastRoster) {
map[p.player_id] = 'RELEASE';
}
return map;
});
useEffect(() => {
setPastRoster(initialPastRoster);
setDecisions((prev) => {
const next = {};
for (const p of initialPastRoster) {
next[p.player_id] = prev[p.player_id] ?? 'RELEASE';
}
return next;
});
}, [initialPastRoster]);
const selections = useMemo(
() =>
pastRoster.map((p) => ({
player_id: p.player_id,
decision: decisions[p.player_id] ?? 'RELEASE',
})),
[pastRoster, decisions]
);
const summary = useMemo(
() => evaluateRetentionChoices(pastRoster, selections, settings),
[pastRoster, selections, settings]
);
const filteredCatalog = useMemo(() => {
const q = searchQuery.trim().toLowerCase();
const existingIds = new Set(pastRoster.map((p) => p.player_id));
return availablePlayersCatalog
.filter((p) => !existingIds.has(p.player_id))
.filter(
(p) =>
!q ||
p.full_name.toLowerCase().includes(q) ||
p.ipl_team.toLowerCase().includes(q) ||
p.role.toLowerCase().includes(q)
)
.slice(0, 8);
}, [availablePlayersCatalog, pastRoster, searchQuery]);
function addPastPlayer(player) {
const nextRoster = [...pastRoster, player];
setPastRoster(nextRoster);
setDecisions((prev) => ({ ...prev, [player.player_id]: 'RELEASE' }));
}
function removePastPlayer(playerId) {
setPastRoster((prev) => prev.filter((p) => p.player_id !== playerId));
setDecisions((prev) => {
const copy = { ...prev };
delete copy[playerId];
return copy;
});
}
function toggleDecision(playerId) {
setDecisions((prev) => ({
...prev,
[playerId]: prev[playerId] === 'RETAIN' ? 'RELEASE' : 'RETAIN',
}));
}
function handleJsonUpload(e) {
const file = e.target.files?.[0];
if (!file) return;
const reader = new FileReader();
reader.onload = () => {
try {
const parsed = JSON.parse(String(reader.result));
if (Array.isArray(parsed)) {
setPastRoster(parsed);
const nextDec = {};
for (const item of parsed) {
if (item.player_id) nextDec[item.player_id] = 'RELEASE';
}
setDecisions(nextDec);
}
} catch {
// Ignore invalid JSON file
}
};
reader.readAsText(file);
}
return (
<div className="space-y-6 rounded-xl border border-slate-800 bg-slate-950 p-6 text-slate-100">
<div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
<div>
<h2 className="text-xl font-bold">{teamName} — Past Squad & Retention</h2>
<p className="text-sm text-slate-400">
Import last season's players, choose who to Retain or Release, and lock in your auction purse.
</p>
</div>
<div className="flex items-center gap-4 text-sm">
<div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
<span className="text-slate-400">Retained: </span>
<span className="font-bold text-emerald-400">
{summary.retained_players.length} / {settings.max_retentions}
</span>
</div>
<div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
<span className="text-slate-400">Purse Left: </span>
<span className="font-bold text-amber-300">
₹{summary.remaining_purse.toFixed(2)} Cr
</span>
</div>
</div>
</div>
<div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 space-y-3">
<div className="flex flex-wrap items-center justify-between gap-3">
<p className="text-sm font-semibold">Import Previous Season Squad</p>
<div className="flex items-center gap-2">
<label className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700">
Upload JSON
<input
type="file"
accept="application/json"
onChange={handleJsonUpload}
className="hidden"
/>
</label>
<button
type="button"
onClick={() => onImportRoster(pastRoster)}
className="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-emerald-400 border border-emerald-500/30 hover:bg-slate-700"
>
Save Imported Squad
</button>
</div>
</div>
<input
type="text"
placeholder="Search player name, IPL team, or role (WK, BAT, AR, BOWL) to add to past squad..."
value={searchQuery}
onChange={(e) => setSearchQuery(e.target.value)}
className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
/>
{filteredCatalog.length > 0 && (
<div className="divide-y divide-slate-800 rounded border border-slate-800 bg-slate-950">
{filteredCatalog.map((player) => (
<div
key={player.player_id}
className="flex items-center justify-between px-3 py-2 text-xs"
>
<div>
<span className="font-semibold">{player.full_name}</span>{' '}
<span className="text-slate-400">
({player.role} • {player.ipl_team}
{player.is_overseas ? ' • OS' : ''})
</span>
</div>
<button
type="button"
onClick={() => addPastPlayer(player)}
className="rounded bg-emerald-500/20 px-2.5 py-1 font-semibold text-emerald-300 hover:bg-emerald-500/30"
>
+ Add
</button>
</div>
))}
</div>
)}
</div>
{summary.errors.length > 0 && (
<div className="rounded-lg border border-red-500/50 bg-red-950/40 p-4 text-sm text-red-200">
<ul className="list-disc pl-5 space-y-1">
{summary.errors.map((err, i) => (
<li key={i}>{err}</li>
))}
</ul>
</div>
)}
<div className="overflow-x-auto rounded-lg border border-slate-800">
<table className="w-full text-left text-sm">
<thead className="bg-slate-900 text-xs uppercase text-slate-400">
<tr>
<th className="px-4 py-3">Player</th>
<th className="px-4 py-3">Role</th>
<th className="px-4 py-3">IPL Team</th>
<th className="px-4 py-3">Prev Price</th>
<th className="px-4 py-3">Deduction</th>
<th className="px-4 py-3">Status</th>
<th className="px-4 py-3 text-right">Action</th>
</tr>
</thead>
<tbody className="divide-y divide-slate-800">
{pastRoster.map((player) => {
const retainedEntry = summary.retained_players.find(
(r) => r.player_id === player.player_id
);
const isRetained = Boolean(retainedEntry);
return (
<tr key={player.player_id} className="hover:bg-slate-900/50">
<td className="px-4 py-3 font-medium">
{player.full_name}{' '}
{player.is_overseas && (
<span className="ml-1 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">
OS
</span>
)}
</td>
<td className="px-4 py-3 text-xs text-slate-300">{player.role}</td>
<td className="px-4 py-3 text-xs text-slate-300">{player.ipl_team}</td>
<td className="px-4 py-3 text-xs text-slate-300">
₹{player.previous_price.toFixed(2)} Cr
</td>
<td className="px-4 py-3 text-xs font-semibold text-amber-300">
{isRetained ? -₹${retainedEntry.deducted_amount.toFixed(2)} Cr : '—'}
</td>
<td className="px-4 py-3 text-xs">
{isRetained ? (
<span className="rounded bg-emerald-500/20 px-2 py-0.5 font-semibold text-emerald-300">
RETAIN (#{retainedEntry.retention_slot})
</span>
) : (
<span className="rounded bg-rose-500/20 px-2 py-0.5 font-semibold text-rose-300">
RELEASE (Auction Pool)
</span>
)}
</td>
<td className="px-4 py-3 text-right space-x-2">
<button
type="button"
onClick={() => toggleDecision(player.player_id)}
className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-medium hover:bg-slate-700"
>
{isRetained ? 'Release' : 'Retain'}
</button>
<button
type="button"
onClick={() => removePastPlayer(player.player_id)}
className="rounded px-2 py-1 text-xs text-slate-400 hover:text-rose-400"
>
Remove
</button>
</td>
</tr>
);
})}
{pastRoster.length === 0 && (
<tr>
<td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">
No past-season players added yet. Search above or upload a JSON roster.
</td>
</tr>
)}
</tbody>
</table>
</div>
<div className="flex items-center justify-between pt-2">
<p className="text-xs text-slate-400">
Released players automatically enter the auction pool; retained players lock into your squad.
</p>
<button
type="button"
disabled={!summary.valid || pastRoster.length === 0}
onClick={() =>
onConfirmRetentions(
summary.retained_players.map((p) => p.player_id),
summary.released_players.map((p) => p.player_id),
summary.remaining_purse
)
}
className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-bold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
>
Lock Retention & Release
</button>
</div>
</div>
);
}
function LiveAuctionRoom({
state,
currentMemberId,
isCommissioner,
settings,
increments,
errorMessage,
onPlaceBid,
onUseRtm,
onDeclineRtm,
onCounterRaise,
onSkipCounter,
onStartAcceleratedRound,
}) {
const [secondsLeft, setSecondsLeft] = useState(0);
const [counterInput, setCounterInput] = useState('');
useEffect(() => {
if (!state.timer_expires_at) {
setSecondsLeft(0);
return;
}
const updateClock = () => {
const diff = Math.max(
0,
Math.ceil((Date.parse(state.timer_expires_at) - Date.now()) / 1000)
);
setSecondsLeft(diff);
};
updateClock();
const id = setInterval(updateClock, 250);
return () => clearInterval(id);
}, [state.timer_expires_at]);
const myManager = state.managers[currentMemberId];
const player = state.current_player;
const nextBid = useMemo(() => {
if (!player) return 0;
return getNextBidAmount(state.current_bid_amount, player.base_price, increments);
}, [player, state.current_bid_amount, increments]);
const bidEligibility = useMemo(() => {
if (!myManager || !player) return { allowed: false, reason: '' };
return canManagerAcquirePlayer(myManager, player, nextBid, settings);
}, [myManager, player, nextBid, settings]);
const highestBidderName = state.current_highest_bidder_id
? state.managers[state.current_highest_bidder_id]?.team_name ?? 'Unknown'
: 'No Bids Yet';
const isFormerOwner = Boolean(player && player.former_owner_member_id === currentMemberId);
const isHighestBidder = state.current_highest_bidder_id === currentMemberId;
return (
<div className="space-y-6 rounded-xl border border-slate-800 bg-slate-950 p-6 text-slate-100">
<div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
<div>
<span className="rounded bg-emerald-500/20 px-2.5 py-1 text-xs font-bold text-emerald-300">
{state.round_type} ROUND • {state.status}
</span>
<h2 className="mt-2 text-xl font-bold">Live Player Auction</h2>
</div>
<div className="flex items-center gap-4 text-xs">
<div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
Queue Left: <span className="font-bold">{state.queue_remaining_count}</span>
</div>
<div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
Unsold Pool: <span className="font-bold text-amber-300">{state.unsold_count}</span>
</div>
{isCommissioner && state.unsold_count > 0 && state.queue_remaining_count === 0 && (
<button
type="button"
onClick={onStartAcceleratedRound}
className="rounded-lg bg-amber-500 px-3 py-2 font-bold text-slate-950 hover:bg-amber-400"
>
Start Accelerated Round
</button>
)}
</div>
</div>
{errorMessage && (
<div className="rounded-lg border border-red-500/50 bg-red-950/40 p-3 text-sm text-red-200">
{errorMessage}
</div>
)}
<div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
<div className="lg:col-span-2 rounded-xl border border-slate-800 bg-slate-900/70 p-6 space-y-6">
{player ? (
<>
<div className="flex flex-wrap items-start justify-between gap-4">
<div>
<div className="flex items-center gap-2 text-xs text-slate-400">
<span className="rounded bg-slate-800 px-2 py-0.5 font-semibold text-slate-200">
{player.set_category} SET
</span>
<span>•</span>
<span>{player.role}</span>
<span>•</span>
<span>{player.ipl_team}</span>
{player.is_overseas && (
<span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-sky-300">
OVERSEAS
</span>
)}
</div>
<h3 className="mt-2 text-3xl font-extrabold">{player.full_name}</h3>
<p className="mt-1 text-sm text-slate-400">
Base Price: ₹{player.base_price.toFixed(2)} Cr
</p>
</div>
<div className="text-center rounded-xl border border-slate-700 bg-slate-950 px-5 py-3">
<p className="text-[11px] uppercase tracking-wider text-slate-400">Timer</p>
<p
className={text-3xl font-black ${ secondsLeft <= 5 ? 'text-rose-400' : 'text-emerald-400' }}
>
{secondsLeft}s
</p>
</div>
</div>
<div className="grid grid-cols-2 gap-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
<div>
<p className="text-xs text-slate-400">Current Bid</p>
<p className="text-2xl font-bold text-amber-300">
₹{(state.current_bid_amount ?? player.base_price).toFixed(2)} Cr
</p>
</div>
<div>
<p className="text-xs text-slate-400">Highest Bidder</p>
<p className="text-xl font-bold text-slate-100">{highestBidderName}</p>
</div>
</div>
{state.awaiting_rtm ? (
<div className="rounded-xl border border-amber-500/50 bg-amber-950/30 p-4 space-y-3">
<p className="text-sm font-semibold text-amber-200">
Right to Match (RTM) Decision Pending
</p>
{isFormerOwner ? (
<div className="flex gap-3">
<button
type="button"
onClick={onUseRtm}
className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-emerald-400"
>
Match ₹{(state.current_bid_amount ?? 0).toFixed(2)} Cr (Use RTM)
</button>
<button
type="button"
onClick={onDeclineRtm}
className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold hover:bg-slate-700"
>
Pass
</button>
</div>
) : (
<p className="text-xs text-slate-300">
Waiting for former owner to decide on RTM...
</p>
)}
</div>
) : state.awaiting_rtm_counter ? (
<div className="rounded-xl border border-sky-500/50 bg-sky-950/30 p-4 space-y-3">
<p className="text-sm font-semibold text-sky-200">
RTM Invoked — Highest Bidder Final Raise Opportunity
</p>
{isHighestBidder ? (
<div className="flex flex-wrap items-center gap-3">
<input
type="number"
step="0.25"
placeholder={> ${(state.current_bid_amount ?? 0).toFixed(2)}}
value={counterInput}
onChange={(e) => setCounterInput(e.target.value)}
className="w-36 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
/>
<button
type="button"
onClick={() => onCounterRaise(Number(counterInput))}
className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-emerald-400"
>
Submit Final Raise
</button>
<button
type="button"
onClick={onSkipCounter}
className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700"
>
Hold Bid
</button>
</div>
) : (
<p className="text-xs text-slate-300">
Waiting for {highestBidderName} to decide on a final counter-raise...
</p>
)}
</div>
) : (
<div className="space-y-2">
<button
type="button"
disabled={
state.status !== 'LIVE' || isHighestBidder || !bidEligibility.allowed
}
onClick={() => onPlaceBid(nextBid)}
className="w-full rounded-xl bg-emerald-500 py-3.5 text-base font-extrabold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
>
{isHighestBidder
? 'You Hold the Highest Bid'
: Bid ₹${nextBid.toFixed(2)} Cr}
</button>
{!isHighestBidder && !bidEligibility.allowed && bidEligibility.reason && (
<p className="text-xs text-rose-400">{bidEligibility.reason}</p>
)}
</div>
)}
</>
) : (
<div className="py-16 text-center text-slate-400">
No player currently on the auction block.
</div>
)}
</div>
<div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 flex flex-col">
<h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 mb-3">
Live Auction Feed
</h3>
<div className="flex-1 space-y-2 overflow-y-auto max-h-80 pr-1 text-xs">
{state.activity_feed.map((item) => (
<div
key={item.id}
className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-slate-300"
>
{item.message}
</div>
))}
{state.activity_feed.length === 0 && (
<p className="text-slate-500">Bids and sales will appear here live.</p>
)}
</div>
</div>
</div>
<div className="overflow-x-auto rounded-xl border border-slate-800">
<table className="w-full text-left text-xs">
<thead className="bg-slate-900 uppercase text-slate-400">
<tr>
<th className="px-4 py-3">Team</th>
<th className="px-4 py-3">Purse Left</th>
<th className="px-4 py-3">Squad Slots</th>
<th className="px-4 py-3">Overseas</th>
<th className="px-4 py-3">WK / BAT / AR / BOWL</th>
<th className="px-4 py-3">RTM Cards</th>
</tr>
</thead>
<tbody className="divide-y divide-slate-800">
{Object.values(state.managers).map((mgr) => {
const overseasCount = mgr.squad.filter((p) => p.is_overseas).length;
const wk = mgr.squad.filter((p) => p.role === 'WK').length;
const bat = mgr.squad.filter((p) => p.role === 'BAT').length;
const ar = mgr.squad.filter((p) => p.role === 'AR').length;
const bowl = mgr.squad.filter((p) => p.role === 'BOWL').length;
return (
<tr key={mgr.member_id} className="hover:bg-slate-900/40">
<td className="px-4 py-3 font-semibold text-slate-100">{mgr.team_name}</td>
<td className="px-4 py-3 font-bold text-amber-300">
₹{mgr.purse_remaining.toFixed(2)} Cr
</td>
<td className="px-4 py-3">
{mgr.squad.length} / {settings.squad_size}
</td>
<td className="px-4 py-3">
{overseasCount} / {settings.max_overseas_squad ?? '∞'}
</td>
<td className="px-4 py-3 text-slate-300">
{wk} / {bat} / {ar} / {bowl}
</td>
<td className="px-4 py-3">
{settings.rtm_enabled ? mgr.rtm_cards_remaining : 'Disabled'}
</td>
</tr>
);
})}
</tbody>
</table>
</div>
</div>
);
}
function WeeklyPitchManager({
teamName,
gameweekNumber,
deadlineIso,
purseRemaining,
freeTransfersAvailable,
settings,
initialSquad,
marketPool,
onSaveLineup,
onExecuteTransfer,
}) {
const [squad, setSquad] = useState(initialSquad);
const [viewMode, setViewMode] = useState('PITCH');
const [selectedPlayerId, setSelectedPlayerId] = useState(null);
const [activeChip, setActiveChip] = useState(null);
const [transferOutId, setTransferOutId] = useState('');
const [transferInId, setTransferInId] = useState('');
const [transferMode, setTransferMode] = useState('FREE_AGENT');
const [statusMessage, setStatusMessage] = useState(null);
useEffect(() => {
setSquad(initialSquad);
}, [initialSquad]);
const xiPlayers = useMemo(() => squad.filter((p) => p.is_playing_xi), [squad]);
const benchPlayers = useMemo(
() =>
squad
.filter((p) => !p.is_playing_xi)
.sort((a, b) => (a.bench_priority ?? 99) - (b.bench_priority ?? 99)),
[squad]
);
const xiValidationErrors = useMemo(() => {
const errs = [];
if (xiPlayers.length !== settings.playing_xi_size) {
errs.push(
Playing XI must have ${settings.playing_xi_size} players (currently ${xiPlayers.length}).
);
}
const counts = { WK: 0, BAT: 0, AR: 0, BOWL: 0 };
let osCount = 0;
for (const p of xiPlayers) {
counts[p.role] += 1;
if (p.is_overseas) osCount += 1;
}
if (counts.WK < settings.xi_min_wk || counts.WK > settings.xi_max_wk) {
errs.push(XI WK must be between ${settings.xi_min_wk} and ${settings.xi_max_wk}.);
}
if (counts.BAT < settings.xi_min_bat || counts.BAT > settings.xi_max_bat) {
errs.push(XI BAT must be between ${settings.xi_min_bat} and ${settings.xi_max_bat}.);
}
if (counts.AR < settings.xi_min_ar || counts.AR > settings.xi_max_ar) {
errs.push(XI AR must be between ${settings.xi_min_ar} and ${settings.xi_max_ar}.);
}
if (counts.BOWL < settings.xi_min_bowl || counts.BOWL > settings.xi_max_bowl) {
errs.push(XI BOWL must be between ${settings.xi_min_bowl} and ${settings.xi_max_bowl}.);
}
if (settings.max_overseas_xi !== null && osCount > settings.max_overseas_xi) {
errs.push(Max ${settings.max_overseas_xi} overseas players allowed in Playing XI.);
}
return errs;
}, [xiPlayers, settings]);
function normalizeBenchPriorities(list) {
const bench = list
.filter((p) => !p.is_playing_xi)
.sort((a, b) => (a.bench_priority ?? 99) - (b.bench_priority ?? 99));
const benchRankMap = new Map();
bench.forEach((p, idx) => benchRankMap.set(p.player_id, idx + 1));
return list.map((p) => ({
...p,
bench_priority: p.is_playing_xi ? null : benchRankMap.get(p.player_id) ?? 1,
}));
}
function handlePlayerClick(clickedId) {
setStatusMessage(null);
if (!selectedPlayerId) {
setSelectedPlayerId(clickedId);
return;
}
if (selectedPlayerId === clickedId) {
setSelectedPlayerId(null);
return;
}
const first = squad.find((p) => p.player_id === selectedPlayerId);
const second = squad.find((p) => p.player_id === clickedId);
if (!first || !second) {
setSelectedPlayerId(null);
return;
}
const updated = squad.map((p) => {
if (p.player_id === first.player_id) {
return {
...p,
is_playing_xi: second.is_playing_xi,
bench_priority: second.bench_priority,
};
}
if (p.player_id === second.player_id) {
return {
...p,
is_playing_xi: first.is_playing_xi,
bench_priority: first.bench_priority,
};
}
return p;
});
setSquad(normalizeBenchPriorities(updated));
setSelectedPlayerId(null);
}
function setCaptain(playerId) {
setSquad((prev) =>
prev.map((p) => ({
...p,
is_captain: p.player_id === playerId,
is_vice_captain: p.player_id === playerId ? false : p.is_vice_captain,
}))
);
}
function setViceCaptain(playerId) {
setSquad((prev) =>
prev.map((p) => ({
...p,
is_vice_captain: p.player_id === playerId,
is_captain: p.player_id === playerId ? false : p.is_captain,
}))
);
}
async function handleSave() {
setStatusMessage(null);
await onSaveLineup({ players: squad, activeChip });
setStatusMessage('Gameweek lineup & chip selection saved.');
}
async function handleTransferSubmit(e) {
e.preventDefault();
if (!transferOutId || !transferInId) return;
setStatusMessage(null);
await onExecuteTransfer({
playerOutId: transferOutId,
playerInId: transferInId,
transferType: transferMode,
});
setTransferOutId('');
setTransferInId('');
setStatusMessage('Transfer submitted.');
}
return (
<div className="space-y-6 rounded-xl border border-slate-800 bg-slate-950 p-6 text-slate-100">
<div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
<div>
<h2 className="text-xl font-bold">
{teamName} — Gameweek {gameweekNumber}
</h2>
<p className="text-xs text-slate-400">
Deadline: {new Date(deadlineIso).toLocaleString()} • Purse: ₹{purseRemaining.toFixed(2)} Cr • Free Transfers: {freeTransfersAvailable}
</p>
</div>
<div className="flex items-center gap-2">
<button
type="button"
onClick={() => setViewMode('PITCH')}
className={rounded-lg px-3 py-1.5 text-xs font-semibold ${ viewMode === 'PITCH' ? 'bg-emerald-500 text-slate-950' : 'border border-slate-700 bg-slate-900 text-slate-300' }}
>
Pitch View
</button>
<button
type="button"
onClick={() => setViewMode('STATS')}
className={rounded-lg px-3 py-1.5 text-xs font-semibold ${ viewMode === 'STATS' ? 'bg-emerald-500 text-slate-950' : 'border border-slate-700 bg-slate-900 text-slate-300' }}
>
Stats & Index View
</button>
<button
type="button"
disabled={xiValidationErrors.length > 0}
onClick={handleSave}
className="rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
>
Save Lineup
</button>
</div>
</div>
<div className="flex flex-wrap items-center gap-2">
<span className="text-xs font-semibold text-slate-400 mr-1">Active Chip:</span>
{[
['TRIPLE_CAPTAIN', 'Triple Captain (3x)', settings.enable_triple_captain],
['BENCH_BOOST', 'Bench Boost', settings.enable_bench_boost],
['WILDCARD', 'Wildcard', settings.enable_wildcard],
['FREE_HIT', 'Free Hit', settings.enable_free_hit],
]
.filter(([, , enabled]) => enabled)
.map(([chipKey, label]) => {
const isSelected = activeChip === chipKey;
return (
<button
key={chipKey}
type="button"
onClick={() => setActiveChip(isSelected ? null : chipKey)}
className={rounded-full px-3 py-1 text-xs font-semibold border ${ isSelected ? 'border-amber-400 bg-amber-500/20 text-amber-300' : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800' }}
>
{label}
</button>
);
})}
</div>
{xiValidationErrors.length > 0 && (
<div className="rounded-lg border border-rose-500/50 bg-rose-950/40 p-3 text-xs text-rose-200">
<ul className="list-disc pl-5 space-y-1">
{xiValidationErrors.map((err, i) => (
<li key={i}>{err}</li>
))}
</ul>
</div>
)}
{statusMessage && (
<div className="rounded-lg border border-emerald-500/50 bg-emerald-950/40 p-3 text-xs text-emerald-200">
{statusMessage}
</div>
)}
{viewMode === 'PITCH' ? (
<div className="space-y-4">
<p className="text-xs text-slate-400">
Click any two players to swap Playing XI / Bench spots or reorder bench priority.
{selectedPlayerId && ' (Select a second player to swap)'}
</p>
<div className="rounded-2xl border border-emerald-700/40 bg-gradient-to-b from-emerald-950/70 via-emerald-900/40 to-emerald-950/80 p-5 space-y-4">
<p className="text-center text-xs font-bold uppercase tracking-widest text-emerald-300">
Playing XI ({xiPlayers.length} / {settings.playing_xi_size})
</p>
<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
{xiPlayers.map((p) => {
const isSelected = selectedPlayerId === p.player_id;
return (
<div
key={p.player_id}
onClick={() => handlePlayerClick(p.player_id)}
className={cursor-pointer rounded-xl border p-3 transition ${ isSelected ? 'border-amber-400 bg-slate-900 ring-2 ring-amber-400/40' : 'border-slate-700/80 bg-slate-950/90 hover:border-emerald-400/60' }}
>
<div className="flex items-center justify-between gap-2">
<span className="font-bold text-sm truncate">{p.full_name}</span>
<span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-extrabold text-emerald-300">
{p.gw_points} pts
</span>
</div>
<div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
<span>
{p.role} • {p.ipl_team}
{p.is_overseas ? ' • OS' : ''}
</span>
<span>{p.next_fixture ?? ''}</span>
</div>
<div
className="mt-2.5 flex items-center gap-2 text-[11px]"
onClick={(e) => e.stopPropagation()}
>
<button
type="button"
onClick={() => setCaptain(p.player_id)}
className={rounded px-2 py-0.5 font-bold ${ p.is_captain ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-400 hover:text-white' }}
>
C
</button>
<button
type="button"
onClick={() => setViceCaptain(p.player_id)}
className={rounded px-2 py-0.5 font-bold ${ p.is_vice_captain ? 'bg-sky-400 text-slate-950' : 'bg-slate-800 text-slate-400 hover:text-white' }}
>
VC
</button>
</div>
</div>
);
})}
</div>
</div>
<div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
<p className="text-xs font-bold uppercase tracking-wider text-slate-400">
Substitutes Bench (Auto-Sub Priority Order)
</p>
<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
{benchPlayers.map((p) => {
const isSelected = selectedPlayerId === p.player_id;
return (
<div
key={p.player_id}
onClick={() => handlePlayerClick(p.player_id)}
className={cursor-pointer rounded-xl border p-3 ${ isSelected ? 'border-amber-400 bg-slate-950 ring-2 ring-amber-400/40' : 'border-slate-800 bg-slate-950 hover:border-slate-600' }}
>
<div className="flex items-center justify-between">
<span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-slate-300">
#{p.bench_priority}
</span>
<span className="text-xs font-bold text-slate-300">{p.gw_points} pts</span>
</div>
<p className="mt-1.5 font-semibold text-sm truncate">{p.full_name}</p>
<p className="text-[11px] text-slate-400">
{p.role} • {p.ipl_team}
{p.is_overseas ? ' • OS' : ''}
</p>
</div>
);
})}
</div>
</div>
</div>
) : (
<div className="overflow-x-auto rounded-xl border border-slate-800">
<table className="w-full text-left text-xs">
<thead className="bg-slate-900 uppercase text-slate-400">
<tr>
<th className="px-4 py-3">Player</th>
<th className="px-4 py-3">Role</th>
<th className="px-4 py-3">Slot</th>
<th className="px-4 py-3">Form</th>
<th className="px-4 py-3">Own %</th>
<th className="px-4 py-3">Price</th>
<th className="px-4 py-3 text-right">GW Pts</th>
</tr>
</thead>
<tbody className="divide-y divide-slate-800">
{squad.map((p) => (
<tr key={p.player_id} className="hover:bg-slate-900/40">
<td className="px-4 py-3 font-semibold">
{p.full_name}{' '}
{p.is_captain && (
<span className="ml-1 rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
C
</span>
)}
{p.is_vice_captain && (
<span className="ml-1 rounded bg-sky-400/20 px-1.5 py-0.5 text-[10px] font-bold text-sky-300">
VC
</span>
)}
</td>
<td className="px-4 py-3">{p.role}</td>
<td className="px-4 py-3">
{p.is_playing_xi ? 'Playing XI' : Bench #${p.bench_priority}}
</td>
<td className="px-4 py-3">{p.form_rating.toFixed(1)}</td>
<td className="px-4 py-3">{p.ownership_pct.toFixed(1)}%</td>
<td className="px-4 py-3">₹{p.market_price.toFixed(2)} Cr</td>
<td className="px-4 py-3 text-right font-bold text-emerald-400">
{p.gw_points}
</td>
</tr>
))}
</tbody>
</table>
</div>
)}
<form
onSubmit={handleTransferSubmit}
className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-4"
>
<div className="flex flex-wrap items-center justify-between gap-2">
<h3 className="text-sm font-bold">Weekly Transfer & Trade Desk</h3>
<div className="flex gap-2 text-xs">
<button
type="button"
onClick={() => setTransferMode('FREE_AGENT')}
className={rounded px-3 py-1 font-semibold ${ transferMode === 'FREE_AGENT' ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300' }}
>
Unsold / Free Agent Pool
</button>
<button
type="button"
onClick={() => setTransferMode('MANAGER_TRADE')}
className={rounded px-3 py-1 font-semibold ${ transferMode === 'MANAGER_TRADE' ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300' }}
>
Manager-to-Manager Trade
</button>
</div>
</div>
<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
<select
value={transferOutId}
onChange={(e) => setTransferOutId(e.target.value)}
className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
>
<option value="">Select Player OUT...</option>
{squad.map((p) => (
<option key={p.player_id} value={p.player_id}>
{p.full_name} ({p.role}, ₹{p.market_price.toFixed(2)} Cr)
</option>
))}
</select>
<select
value={transferInId}
onChange={(e) => setTransferInId(e.target.value)}
className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
>
<option value="">Select Player IN...</option>
{marketPool
.filter((m) => (transferMode === 'FREE_AGENT' ? !m.is_owned : m.is_owned))
.map((m) => (
<option key={m.player_id} value={m.player_id}>
{m.full_name} ({m.role}, ₹{m.market_price.toFixed(2)} Cr
{m.owner_team_name ?  • ${m.owner_team_name} : ' • Unsold Pool'})
</option>
))}
</select>
<button
type="submit"
disabled={!transferOutId || !transferInId}
className="rounded bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
>
Confirm Transfer
</button>
</div>
</form>
</div>
);
}
function LeagueStandingsTable({ rows, availableGameweeks, onSelectTeam }) {
const [filterType, setFilterType] = useState('OVERALL');
const [selectedGw, setSelectedGw] = useState(
availableGameweeks[availableGameweeks.length - 1] ?? 1
);
const [selectedMonth, setSelectedMonth] = useState('ALL');
const months = useMemo(() => {
const set = new Set();
for (const r of rows) {
if (r.month_key) set.add(r.month_key);
}
return Array.from(set);
}, [rows]);
const sortedRows = useMemo(() => {
const withDisplayScore = rows.map((r) => {
let displayPoints = r.total_points;
if (filterType === 'GW') {
displayPoints = r.gw_by_number[selectedGw] ?? 0;
} else if (filterType === 'MONTH' && selectedMonth !== 'ALL') {
displayPoints = r.month_key === selectedMonth ? r.total_points : 0;
}
return { ...r, displayPoints };
});
return withDisplayScore.sort((a, b) => b.displayPoints - a.displayPoints);
}, [rows, filterType, selectedGw, selectedMonth]);
function renderRankMovement(current, previous) {
if (previous === null) return <span className="text-slate-500">—</span>;
if (current < previous) {
return <span className="text-emerald-400 font-bold">▲ {previous - current}</span>;
}
if (current > previous) {
return <span className="text-rose-400 font-bold">▼ {current - previous}</span>;
}
return <span className="text-slate-400">•</span>;
}
return (
<div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950 p-6 text-slate-100">
<div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
<div>
<h2 className="text-xl font-bold">League Standings</h2>
<p className="text-xs text-slate-400">
Live weekly and cumulative season points across all competing teams.
</p>
</div>
<div className="flex flex-wrap items-center gap-2 text-xs">
<button
type="button"
onClick={() => setFilterType('OVERALL')}
className={rounded-lg px-3 py-1.5 font-semibold ${ filterType === 'OVERALL' ? 'bg-emerald-500 text-slate-950' : 'bg-slate-900 text-slate-300 border border-slate-700' }}
>
Overall Season
</button>
<div className="flex items-center gap-1">
<button
type="button"
onClick={() => setFilterType('GW')}
className={rounded-lg px-3 py-1.5 font-semibold ${ filterType === 'GW' ? 'bg-emerald-500 text-slate-950' : 'bg-slate-900 text-slate-300 border border-slate-700' }}
>
Gameweek
</button>
<select
value={selectedGw}
onChange={(e) => {
setSelectedGw(Number(e.target.value));
setFilterType('GW');
}}
className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5"
>
{availableGameweeks.map((gw) => (
<option key={gw} value={gw}>
GW {gw}
</option>
))}
</select>
</div>
{months.length > 0 && (
<div className="flex items-center gap-1">
<button
type="button"
onClick={() => setFilterType('MONTH')}
className={rounded-lg px-3 py-1.5 font-semibold ${ filterType === 'MONTH' ? 'bg-emerald-500 text-slate-950' : 'bg-slate-900 text-slate-300 border border-slate-700' }}
>
Monthly
</button>
<select
value={selectedMonth}
onChange={(e) => {
setSelectedMonth(e.target.value);
setFilterType('MONTH');
}}
className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5"
>
<option value="ALL">All Months</option>
{months.map((m) => (
<option key={m} value={m}>
{m}
</option>
))}
</select>
</div>
)}
</div>
</div>
<div className="overflow-x-auto rounded-xl border border-slate-800">
<table className="w-full text-left text-sm">
<thead className="bg-slate-900 text-xs uppercase text-slate-400">
<tr>
<th className="px-4 py-3">Pos</th>
<th className="px-4 py-3">Move</th>
<th className="px-4 py-3">Team & Manager</th>
<th className="px-4 py-3 text-right">GW Pts</th>
<th className="px-4 py-3 text-right">Total Pts</th>
</tr>
</thead>
<tbody className="divide-y divide-slate-800">
{sortedRows.map((row, index) => (
<tr
key={row.member_id}
onClick={() => onSelectTeam?.(row.member_id)}
className="cursor-pointer hover:bg-slate-900/60"
>
<td className="px-4 py-3 font-bold">{index + 1}</td>
<td className="px-4 py-3 text-xs">
{renderRankMovement(row.current_rank, row.previous_rank)}
</td>
<td className="px-4 py-3">
<div className="font-semibold text-slate-100">{row.team_name}</div>
<div className="text-xs text-slate-400">{row.manager_name}</div>
</td>
<td className="px-4 py-3 text-right font-semibold text-emerald-400">
{row.gw_points}
</td>
<td className="px-4 py-3 text-right font-extrabold text-amber-300">
{row.displayPoints}
</td>
</tr>
))}
</tbody>
</table>
</div>
</div>
);
}
// ============================================================================
// 5. MAIN EXPORTED APP COMPONENT
// ============================================================================
export default function App() {
const [activeTab, setActiveTab] = useState('AUCTION');
const [snapshot, setSnapshot] = useState(FALLBACK_SNAPSHOT);
const [activeMemberId, setActiveMemberId] = useState('m1');
const [auctionError, setAuctionError] = useState(null);
const [syncStatus, setSyncStatus] = useState('Local / Standalone');
const channelRef = useRef(null);
const applyIncomingSnapshot = useCallback((remote) => {
if (!remote || !remote.updated_at) return;
setSnapshot((prev) => {
if (Date.parse(remote.updated_at) >= Date.parse(prev.updated_at)) {
return remote;
}
return prev;
});
}, []);
const commitSharedSnapshot = useCallback(async (next) => {
const stamped = {
...next,
updated_at: new Date().toISOString(),
};
setSnapshot(stamped);
channelRef.current?.publishSnapshot(stamped);
try {
await pushRemoteLeagueSnapshot(stamped);
setSyncStatus('Synced (Shared API)');
} catch {
setSyncStatus('Local Tab Sync Only');
}
}, []);
useEffect(() => {
let active = true;
const bc = createSharedLeagueChannel((remoteSnap) => {
if (active) {
applyIncomingSnapshot(remoteSnap);
setSyncStatus('Synced (Browser Tabs)');
}
});
channelRef.current = bc;
async function pollSharedState() {
try {
const data = await fetchRemoteLeagueSnapshot(FALLBACK_SNAPSHOT.league_id);
if (active) {
applyIncomingSnapshot(data);
setSyncStatus('Synced (Shared API)');
}
} catch {
if (active) {
setSyncStatus('Local / Standalone');
}
}
}
pollSharedState();
const interval = setInterval(pollSharedState, 1500);
return () => {
active = false;
clearInterval(interval);
bc.close();
};
}, [applyIncomingSnapshot]);
const settings = snapshot.settings;
const currentManager =
snapshot.managers.find((m) => m.member_id === activeMemberId) ?? snapshot.managers[0];
const currentPastRoster = snapshot.past_rosters_by_member[activeMemberId] ?? [];
const currentSquad = snapshot.squads_by_member[activeMemberId] ?? INITIAL_SQUAD;
const currentPurse = snapshot.purses_by_member[activeMemberId] ?? settings.starting_purse;
const currentFreeTransfers =
snapshot.free_transfers_by_member[activeMemberId] ?? settings.free_transfers_per_gw;
function handleAddManager(displayName, teamName) {
const newId = m${snapshot.managers.length + 1};
const nextManagers = [
...snapshot.managers,
{
member_id: newId,
user_id: u${snapshot.managers.length + 1},
display_name: displayName,
team_name: teamName,
is_commissioner: false,
},
];
const nextAuctionManagers = {
...snapshot.auction.managers,
[newId]: {
member_id: newId,
team_name: teamName,
purse_remaining: settings.starting_purse,
rtm_cards_remaining: settings.rtm_enabled ? settings.rtm_cards_per_manager : 0,
squad: [],
},
};
const nextStandings = [
...snapshot.standings,
{
member_id: newId,
team_name: teamName,
manager_name: displayName,
current_rank: nextManagers.length,
previous_rank: null,
gw_points: 0,
gw_by_number: { 1: 0, 2: 0 },
month_key: '2026-11',
total_points: 0,
},
];
const nextSnap = {
...snapshot,
managers: nextManagers,
auction: {
...snapshot.auction,
managers: nextAuctionManagers,
},
standings: nextStandings,
past_rosters_by_member: {
...snapshot.past_rosters_by_member,
[newId]: [],
},
squads_by_member: {
...snapshot.squads_by_member,
[newId]: INITIAL_SQUAD,
},
purses_by_member: {
...snapshot.purses_by_member,
[newId]: settings.starting_purse,
},
free_transfers_by_member: {
...snapshot.free_transfers_by_member,
[newId]: settings.free_transfers_per_gw,
},
};
setActiveMemberId(newId);
void commitSharedSnapshot(nextSnap);
}
async function handleSaveSettings(updated) {
await commitSharedSnapshot({
...snapshot,
settings: updated,
});
}
async function handleImportRoster(players) {
await commitSharedSnapshot({
...snapshot,
past_rosters_by_member: {
...snapshot.past_rosters_by_member,
[activeMemberId]: players,
},
});
}
async function handleConfirmRetentions(retainedIds, _releasedIds, nextPurse) {
const retainedSquadForAuction = currentPastRoster
.filter((p) => retainedIds.includes(p.player_id))
.map((p) => ({
player_id: p.player_id,
role: p.role,
ipl_team: p.ipl_team,
is_overseas: p.is_overseas,
price: p.previous_price,
}));
const existingMgr = snapshot.auction.managers[activeMemberId] ?? {
member_id: activeMemberId,
team_name: currentManager.team_name,
purse_remaining: nextPurse,
rtm_cards_remaining: settings.rtm_enabled ? settings.rtm_cards_per_manager : 0,
squad: [],
};
await commitSharedSnapshot({
...snapshot,
purses_by_member: {
...snapshot.purses_by_member,
[activeMemberId]: nextPurse,
},
auction: {
...snapshot.auction,
managers: {
...snapshot.auction.managers,
[activeMemberId]: {
...existingMgr,
purse_remaining: nextPurse,
squad: retainedSquadForAuction,
},
},
},
});
setActiveTab('AUCTION');
}
function handlePlaceBid(amount) {
setAuctionError(null);
const res = applyBid(
snapshot.auction,
activeMemberId,
amount,
settings,
DEFAULT_BID_INCREMENTS
);
if (!res.ok) {
setAuctionError(res.error ?? 'Invalid bid');
return;
}
void commitSharedSnapshot(syncAuctionIntoSnapshot(snapshot, res.nextState));
}
function handleRtm(action) {
setAuctionError(null);
const res = handleRtmAction(snapshot.auction, action, settings);
if (!res.ok) {
setAuctionError(res.error ?? 'RTM action failed');
return;
}
void commitSharedSnapshot(syncAuctionIntoSnapshot(snapshot, res.nextState));
}
async function handleSaveLineup(payload) {
await commitSharedSnapshot({
...snapshot,
squads_by_member: {
...snapshot.squads_by_member,
[activeMemberId]: payload.players,
},
});
}
async function handleExecuteTransfer({ playerOutId, playerInId }) {
const outgoing = currentSquad.find((p) => p.player_id === playerOutId);
const incoming = INITIAL_MARKET_POOL.find((m) => m.player_id === playerInId);
if (!outgoing || !incoming) return;
const priceDiff = Number((incoming.market_price - outgoing.market_price).toFixed(2));
if (currentPurse - priceDiff < 0) return;
const nextPurse = Number((currentPurse - priceDiff).toFixed(2));
const nextSquad = currentSquad.map((p) =>
p.player_id === outgoing.player_id
? {
player_id: incoming.player_id,
full_name: incoming.full_name,
role: incoming.role,
ipl_team: incoming.ipl_team,
is_overseas: incoming.is_overseas,
is_playing_xi: p.is_playing_xi,
bench_priority: p.bench_priority,
is_captain: false,
is_vice_captain: false,
gw_points: 0,
form_rating: incoming.form_rating,
ownership_pct: incoming.ownership_pct,
market_price: incoming.market_price,
next_fixture: 'Next GW',
}
: p
);
const existingAuctionMgr = snapshot.auction.managers[activeMemberId];
const nextAuctionManagers = existingAuctionMgr
? {
...snapshot.auction.managers,
[activeMemberId]: {
...existingAuctionMgr,
purse_remaining: nextPurse,
},
}
: snapshot.auction.managers;
await commitSharedSnapshot({
...snapshot,
purses_by_member: {
...snapshot.purses_by_member,
[activeMemberId]: nextPurse,
},
free_transfers_by_member: {
...snapshot.free_transfers_by_member,
[activeMemberId]: Math.max(0, currentFreeTransfers - 1),
},
squads_by_member: {
...snapshot.squads_by_member,
[activeMemberId]: nextSquad,
},
auction: {
...snapshot.auction,
managers: nextAuctionManagers,
},
});
}
const tabs = [
['AUCTION', 'Live Auction'],
['PITCH', 'My Pitch & Transfers'],
['RETENTION', 'My Retention & Release'],
['STANDINGS', 'League Standings'],
['SETTINGS', 'League Settings'],
];
return (
<main className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-8">
<div className="mx-auto max-w-6xl space-y-5">
<header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
<div>
<h1 className="text-2xl font-black tracking-tight text-emerald-400">
FANTASY IPL — MULTIPLAYER AUCTION & FPL
</h1>
<p className="text-xs text-slate-400">
Personal Team Controls • Shared Auction & Standings • Sync: {syncStatus}
</p>
</div>
<nav className="flex flex-wrap gap-2">
{tabs.map(([key, label]) => (
<button
key={key}
type="button"
onClick={() => setActiveTab(key)}
className={rounded-lg px-3.5 py-2 text-xs font-bold transition ${ activeTab === key ? 'bg-emerald-500 text-slate-950' : 'border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800' }}
>
{label}
</button>
))}
</nav>
</header>
<ManagerSessionBar
inviteCode={snapshot.invite_code}
managers={snapshot.managers}
activeMemberId={activeMemberId}
onSwitchManager={setActiveMemberId}
onAddManager={handleAddManager}
/>
{activeTab === 'AUCTION' && (
<LiveAuctionRoom
state={snapshot.auction}
currentMemberId={activeMemberId}
isCommissioner={Boolean(currentManager?.is_commissioner)}
settings={settings}
increments={DEFAULT_BID_INCREMENTS}
errorMessage={auctionError}
onPlaceBid={handlePlaceBid}
onUseRtm={() => handleRtm({ type: 'USE_RTM', member_id: activeMemberId })}
onDeclineRtm={() => handleRtm({ type: 'DECLINE_RTM', member_id: activeMemberId })}
onCounterRaise={(amount) =>
handleRtm({
type: 'COUNTER_RAISE',
member_id: activeMemberId,
new_amount: amount,
})
}
onSkipCounter={() =>
handleRtm({ type: 'SKIP_COUNTER', member_id: activeMemberId })
}
onStartAcceleratedRound={() =>
void commitSharedSnapshot({
...snapshot,
auction: {
...snapshot.auction,
round_type: 'ACCELERATED',
unsold_count: 0,
},
})
}
/>
)}
{activeTab === 'PITCH' && (
<WeeklyPitchManager
teamName={currentManager?.team_name ?? 'My Team'}
gameweekNumber={2}
deadlineIso={new Date(Date.now() + 86400000).toISOString()}
purseRemaining={currentPurse}
freeTransfersAvailable={currentFreeTransfers}
settings={settings}
initialSquad={currentSquad}
marketPool={INITIAL_MARKET_POOL}
onSaveLineup={handleSaveLineup}
onExecuteTransfer={handleExecuteTransfer}
/>
)}
{activeTab === 'RETENTION' && (
<RetentionWarRoom
teamName={currentManager?.team_name ?? 'My Team'}
settings={settings}
initialPastRoster={currentPastRoster}
availablePlayersCatalog={CATALOG_PLAYERS}
onImportRoster={handleImportRoster}
onConfirmRetentions={handleConfirmRetentions}
/>
)}
{activeTab === 'STANDINGS' && (
<LeagueStandingsTable
rows={snapshot.standings}
availableGameweeks={[1, 2]}
onSelectTeam={(memberId) => {
setActiveMemberId(memberId);
setActiveTab('PITCH');
}}
/>
)}
{activeTab === 'SETTINGS' && (
<LeagueSettingsConfigurator
initialSettings={settings}
onSave={handleSaveSettings}
/>
)}
</div>
</main>
);
}
