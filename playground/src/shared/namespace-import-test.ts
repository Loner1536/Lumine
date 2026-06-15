// Internal
import type * as Type from "./namespace-test";

const entryPool: Type.Queue.Entry[] = [];
const builderPool: Type.Queue.PooledBuilder[] = [];

export function acquireEntry(id: number, data: unknown): Type.Queue.Entry {
	const entry = entryPool.pop();
	if (entry) {
		entry.id = id;
		entry.data = data;

		entry.target = undefined;
		entry.exclude = undefined;

		entry.delay = undefined;

		return entry;
	}
	return { id, data };
}

export function acquireBuilder(entry: Type.Queue.Entry): Type.Packet.Builder {
	const b = builderPool.pop();
	if (b) {
		b._entry = entry;
		return b;
	}

	const builder: Type.Queue.PooledBuilder = {
		_entry: entry,
		to(target) {
			builder._entry.target = target as Player[];
			return builder;
		},
		except(target) {
			builder._entry.exclude = target;
			return builder;
		},
		after(seconds) {
			builder._entry.delay = seconds;
			return builder;
		},
	};

	return builder;
}

export function releaseEntry(entry: Type.Queue.Entry) {
	entryPool.push(entry);
}
export function releaseBuilder(builder: Type.Packet.Builder) {
	builderPool.push(builder as Type.Queue.PooledBuilder);
}
