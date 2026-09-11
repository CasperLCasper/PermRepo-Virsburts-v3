// accounting-redis.js
// Redis tiek izmantots:
// 1. Express session datiem (server.js izmanto prefiksu permrepo:session:);
// 2. backup job stāvoklim;
// 3. izkliedētajai job slēdzenei.

import { Redis } from '@upstash/redis';
import crypto from 'crypto';

let redis = null;

const DEFAULT_JOB_TTL = Number(process.env.JOB_TTL_SECONDS || 3600);
const JOB_LOCK_TTL = Number(process.env.JOB_LOCK_TTL_SECONDS || 300);

function jobKey(jobId) {
    return `permrepo:job:${jobId}`;
}

function jobLockKey(jobId) {
    return `permrepo:joblock:${jobId}`;
}

export function initRedis() {
    if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN
        });
        console.log('✅ Redis inicializēts | Redis is initialized');
    } else if (!redis) {
        console.log('⚠️ Redis nav konfigurēts | Redis is not configured');
    }

    return redis;
}

export function getRedis() {
    return redis;
}

function requireRedis() {
    if (!redis) {
        throw new Error(
            'Redis nav konfigurēts. PermRepo operācija nav pieejama.'
        );
    }

    return redis;
}

export async function createJob(
    jobId,
    job,
    ttlSeconds = DEFAULT_JOB_TTL
) {
    const client = requireRedis();

    if (
        typeof jobId !== 'string' ||
        !/^[a-f0-9-]{20,100}$/i.test(jobId)
    ) {
        throw new Error('Nederīgs jobId.');
    }

    if (
        !job ||
        typeof job !== 'object' ||
        Array.isArray(job)
    ) {
        throw new Error('Nederīgi job dati.');
    }

    const ttl = Number(ttlSeconds);

    if (
        !Number.isInteger(ttl) ||
        ttl <= 0
    ) {
        throw new Error('Nederīgs job TTL.');
    }

    const key = jobKey(jobId);

    try {
        const result = await client.set(
            key,
            JSON.stringify(job),
            {
                nx: true,
                ex: ttl
            }
        );

        if (result !== 'OK') {
            throw new Error(
                'Job ar šādu ID jau eksistē.'
            );
        }

        return true;
    } catch (error) {
        console.error(
            'Redis createJob kļūda:',
            error
        );

        throw new Error(
            'Backup job izveide neizdevās.'
        );
    }
}

export async function getJob(jobId) {
    const client = requireRedis();

    if (
        typeof jobId !== 'string' ||
        !/^[a-f0-9-]{20,100}$/i.test(jobId)
    ) {
        throw new Error('Nederīgs jobId.');
    }

    try {
        const value =
            await client.get(
                jobKey(jobId)
            );

        if (!value) {
            return null;
        }

        if (typeof value === 'object') {
            return value;
        }

        return JSON.parse(
            String(value)
        );
    } catch (error) {
        console.error(
            'Redis getJob kļūda:',
            error
        );

        throw new Error(
            'Backup job nolasīšana neizdevās.'
        );
    }
}

export async function updateJob(
    jobId,
    patch,
    ttlSeconds = DEFAULT_JOB_TTL
) {
    const client = requireRedis();

    if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch)
    ) {
        throw new Error(
            'Nederīgs job patch.'
        );
    }

    const current =
        await getJob(jobId);

    if (!current) {
        throw new Error(
            'Backup job nav atrasts.'
        );
    }

    const ttl = Number(ttlSeconds);

    if (
        !Number.isInteger(ttl) ||
        ttl <= 0
    ) {
        throw new Error(
            'Nederīgs job TTL.'
        );
    }

    const next = {
        ...current,
        ...patch,
        updatedAt: Date.now()
    };

    await client.set(
        jobKey(jobId),
        JSON.stringify(next),
        {
            ex: ttl
        }
    );

    return next;
}

export async function acquireJobLock(
    jobId,
    ttlSeconds = JOB_LOCK_TTL
) {
    const client = requireRedis();

    if (
        typeof jobId !== 'string' ||
        !/^[a-f0-9-]{20,100}$/i.test(jobId)
    ) {
        throw new Error(
            'Nederīgs jobId.'
        );
    }

    const key =
        jobLockKey(jobId);

    const token =
        crypto.randomUUID();

    const ttl =
        Number(ttlSeconds);

    if (
        !Number.isInteger(ttl) ||
        ttl <= 0
    ) {
        throw new Error(
            'Nederīgs job lock TTL.'
        );
    }

    try {
        const result =
            await client.set(
                key,
                token,
                {
                    nx: true,
                    ex: ttl
                }
            );

        if (result === 'OK') {
            return token;
        }

        return null;
    } catch (error) {
        console.error(
            'Redis job lock iegūšanas kļūda:',
            error
        );

        throw new Error(
            'Redis job slēdzeni nevar iegūt.'
        );
    }
}

export async function releaseJobLock(
    jobId,
    token
) {
    const client =
        requireRedis();

    if (
        typeof token !== 'string' ||
        token.length === 0
    ) {
        return;
    }

    const key =
        jobLockKey(jobId);

    const script = `
        local current = redis.call("GET", KEYS[1])
        if current == ARGV[1] then
            redis.call("DEL", KEYS[1])
            return 1
        end
        return 0
    `;

    try {
        await client.eval(
            script,
            [key],
            [token]
        );
    } catch (error) {
        console.error(
            'Redis job lock atbrīvošanas kļūda:',
            error
        );
    }
}
