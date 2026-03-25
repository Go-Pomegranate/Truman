import type { DayOfWeek, FamilyConfig, MemberConfig, ScheduleEntry } from "../types.js";

const DAY_MAP: Record<number, DayOfWeek> = {
	0: "sun",
	1: "mon",
	2: "tue",
	3: "wed",
	4: "thu",
	5: "fri",
	6: "sat",
};

export interface ScheduledTask {
	family: FamilyConfig;
	member: MemberConfig;
	schedule: ScheduleEntry;
	/** When this task should fire (ms since epoch) */
	fireAt: number;
}

/**
 * Determines which members should act at a given point in time,
 * based on their schedule configs and probability rolls.
 */
export class Scheduler {
	private speed: number;
	private baseTime: number;
	private startTime: number;

	/**
	 * @param speed Time multiplier (1 = real-time, 60 = 1 real min = 1 simulated hour)
	 * @param startTime Override for "now" (useful for testing)
	 */
	constructor(speed = 1, startTime?: Date) {
		this.speed = speed;
		this.startTime = Date.now();
		this.baseTime = startTime?.getTime() ?? Date.now();
	}

	/** Get the current simulated time */
	now(): Date {
		const elapsed = Date.now() - this.startTime;
		return new Date(this.baseTime + elapsed * this.speed);
	}

	/** Get all tasks that should fire right now (within the current tick window) */
	getScheduledTasks(families: FamilyConfig[], tickWindowMs: number): ScheduledTask[] {
		const now = this.now();
		const tasks: ScheduledTask[] = [];

		for (const family of families) {
			for (const member of family.members) {
				for (const schedule of member.schedule) {
					if (this.shouldFire(schedule, now, family.timezone, tickWindowMs)) {
						// Probability check
						if (Math.random() <= schedule.probability) {
							tasks.push({
								family,
								member,
								schedule,
								fireAt: now.getTime(),
							});
						}
					}
				}
			}
		}

		return tasks;
	}

	/**
	 * Check if a schedule entry matches the current time window.
	 */
	private shouldFire(entry: ScheduleEntry, now: Date, timezone: string, tickWindowMs: number): boolean {
		// Check day of week
		const localDay = this.getDayInTimezone(now, timezone);
		if (!entry.days.includes(localDay)) return false;

		// Check time window
		const localTime = this.getTimeInTimezone(now, timezone);
		const [startTime, endTime] = entry.timeWindow;

		const localMinutes = this.timeToMinutes(localTime);
		const startMinutes = this.timeToMinutes(startTime);
		const endMinutes = this.timeToMinutes(endTime);

		// Fire if current time is within the schedule window
		const tickWindowMinutes = (tickWindowMs * this.speed) / 60000;

		return localMinutes >= startMinutes && localMinutes <= Math.min(endMinutes, startMinutes + tickWindowMinutes);
	}

	/** Get next scheduled tasks (for display/planning) */
	getUpcoming(families: FamilyConfig[], count = 10): ScheduledTask[] {
		const now = this.now();
		const upcoming: ScheduledTask[] = [];
		const seen = new Set<string>();

		// Look ahead 24 hours, step by 1 minute
		for (let offsetMin = 0; offsetMin < 1440 && upcoming.length < count; offsetMin++) {
			const futureTime = new Date(now.getTime() + offsetMin * 60000);

			for (const family of families) {
				for (const member of family.members) {
					for (const schedule of member.schedule) {
						// Deduplicate: same member + same action + same time window
						const key = `${member.id}:${schedule.action}:${schedule.timeWindow[0]}`;
						if (seen.has(key)) continue;

						if (this.shouldFire(schedule, futureTime, family.timezone, 60000)) {
							seen.add(key);
							upcoming.push({
								family,
								member,
								schedule,
								fireAt: futureTime.getTime(),
							});
						}
					}
				}
			}
		}

		return upcoming.slice(0, count);
	}

	private getDayInTimezone(date: Date, timezone: string): DayOfWeek {
		try {
			const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" });
			const dayStr = formatter.format(date).toLowerCase().slice(0, 3);
			const dayMap: Record<string, DayOfWeek> = {
				sun: "sun",
				mon: "mon",
				tue: "tue",
				wed: "wed",
				thu: "thu",
				fri: "fri",
				sat: "sat",
			};
			return dayMap[dayStr] ?? DAY_MAP[date.getDay()];
		} catch {
			return DAY_MAP[date.getDay()];
		}
	}

	private getTimeInTimezone(date: Date, timezone: string): string {
		try {
			const formatter = new Intl.DateTimeFormat("en-US", {
				timeZone: timezone,
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
			return formatter.format(date);
		} catch {
			return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		}
	}

	private timeToMinutes(time: string): number {
		const [h, m] = time.split(":").map(Number);
		return h * 60 + m;
	}
}
