import { promises as fsPromises } from 'fs';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { setTimeout as delay } from 'timers/promises';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MEDIA_POLL_INTERVAL_MS = 1000;
const MEDIA_POLL_TIMEOUT_MS = 60 * 1000;

// 環境変数から設定を読み込む
const getConfig = (key, defaultValue = '') => process.env[key] || defaultValue;
const requiredConfigKeys = ['MASTODON_ACCESS_TOKEN', 'MASTODON_API_URL', 'POST_JSON_URL'];

const assertRequiredConfig = () => {
    const missingKeys = requiredConfigKeys.filter(key => !getConfig(key));
    if (missingKeys.length > 0) {
        throw new Error(`環境変数が不足しています: ${missingKeys.join(', ')}`);
    }
};

export const normalizeMastodonBaseUrl = (apiUrl) => {
    const url = new URL(apiUrl);
    url.pathname = url.pathname.replace(/\/api\/v\d+\/?$/i, '/');
    if (!url.pathname.endsWith('/')) {
        url.pathname += '/';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
};

const getLocalPath = (imageSrc) => path.isAbsolute(imageSrc) ? imageSrc : path.resolve(__dirname, imageSrc);

const getExtensionFromSharpFormat = (format) => {
    const extensions = {
        avif: '.avif',
        gif: '.gif',
        heif: '.heif',
        jpeg: '.jpg',
        jpg: '.jpg',
        png: '.png',
        tiff: '.tiff',
        webp: '.webp',
    };
    return extensions[format] || '.jpg';
};

const getMimeTypeFromSharpFormat = (format) => {
    const mimeTypes = {
        avif: 'image/avif',
        gif: 'image/gif',
        heif: 'image/heif',
        jpeg: 'image/jpeg',
        jpg: 'image/jpeg',
        png: 'image/png',
        tiff: 'image/tiff',
        webp: 'image/webp',
    };
    return mimeTypes[format] || 'image/jpeg';
};

const parseResponseBody = async (response) => {
    const text = await response.text();
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

export const createMastodonClient = ({
    baseUrl,
    accessToken,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    mediaPollIntervalMs = MEDIA_POLL_INTERVAL_MS,
    mediaPollTimeoutMs = MEDIA_POLL_TIMEOUT_MS,
}) => {
    const normalizedBaseUrl = normalizeMastodonBaseUrl(baseUrl);

    const request = async (endpoint, options = {}) => {
        const headers = new Headers(options.headers);
        headers.set('Authorization', `Bearer ${accessToken}`);

        const response = await fetch(new URL(endpoint, normalizedBaseUrl), {
            ...options,
            headers,
            signal: AbortSignal.timeout(requestTimeoutMs),
        });
        const body = await parseResponseBody(response);

        if (!response.ok) {
            const detail = typeof body === 'string' ? body : body?.error || JSON.stringify(body);
            const error = new Error(`Mastodon API ${response.status} ${response.statusText}: ${detail}`);
            error.status = response.status;
            throw error;
        }

        return { body, status: response.status };
    };

    const waitForMedia = async (media) => {
        if (media.url) {
            return media;
        }

        const deadline = Date.now() + mediaPollTimeoutMs;
        while (Date.now() < deadline) {
            await delay(mediaPollIntervalMs);
            const { body } = await request(`api/v1/media/${encodeURIComponent(media.id)}`);
            if (body.url) {
                return body;
            }
        }

        throw new Error(`Mastodonでの画像処理がタイムアウトしました: media_id=${media.id}`);
    };

    const uploadMedia = async ({ data, fileName, mimeType, description }) => {
        const form = new FormData();
        form.append('file', new Blob([data], { type: mimeType }), fileName);
        if (description) {
            form.append('description', description);
        }

        const { body } = await request('api/v2/media', {
            method: 'POST',
            body: form,
        });
        return waitForMedia(body);
    };

    const createStatus = async ({ status, mediaIds = [] }) => {
        const form = new URLSearchParams({ status });
        for (const mediaId of mediaIds) {
            form.append('media_ids[]', mediaId);
        }

        const idempotencyKey = randomUUID();
        const send = () => request('api/v1/statuses', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: form,
        });

        try {
            return (await send()).body;
        } catch (error) {
            if (error.status) {
                throw error;
            }
            // 応答前に通信が切れた場合だけ、同じキーで一度再試行して二重投稿を防ぐ。
            return (await send()).body;
        }
    };

    return { createStatus, uploadMedia };
};

const jsonURL = getConfig('POST_JSON_URL');

// JSONを取得
const loadPostData = async () => {
    if (jsonURL.startsWith('http://') || jsonURL.startsWith('https://')) {
        const response = await fetch(jsonURL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    }
    try {
        return JSON.parse(await fsPromises.readFile(jsonURL, 'utf8'));
    } catch (error) {
        console.error(chalk.red('JSONデータの取得中にエラーが発生しました:'), error);
        throw error;
    }
};

// 画像の処理
const uploadImage = async (client, image) => {
    try {
        let buffer;
        if (image.src.startsWith('http://') || image.src.startsWith('https://')) {
            const response = await fetch(image.src, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            if (!response.ok) throw new Error(`画像をダウンロードできません: ${response.statusText}`);
            buffer = Buffer.from(await response.arrayBuffer());
        } else {
            buffer = await fsPromises.readFile(getLocalPath(image.src));
        }

        const { data, info } = await sharp(buffer)
            .resize({ width: 800, fit: 'inside', withoutEnlargement: true })
            .toBuffer({ resolveWithObject: true });

        const media = await client.uploadMedia({
            data,
            fileName: `image-${randomUUID()}${getExtensionFromSharpFormat(info.format)}`,
            mimeType: getMimeTypeFromSharpFormat(info.format),
            description: image.alt || undefined,
        });
        return media.id;
    } catch (error) {
        console.error(chalk.red('画像のアップロードに失敗しました:'), error);
        throw error;
    }
};

// 投稿処理
export const main = async () => {
    try {
        assertRequiredConfig();
        const client = createMastodonClient({
            baseUrl: getConfig('MASTODON_API_URL'),
            accessToken: getConfig('MASTODON_ACCESS_TOKEN'),
        });
        const postData = await loadPostData();
        if (!postData || typeof postData.text !== 'string') {
            throw new Error('投稿データの text は文字列で指定してください');
        }
        const images = Array.isArray(postData?.images) ? postData.images : [];
        if (images.length > 4) {
            throw new Error(`Mastodonに添付できる画像は最大4枚です: ${images.length}枚`);
        }

        const mediaIds = await Promise.all(images.map(image => uploadImage(client, image)));
        await client.createStatus({ status: postData.text, mediaIds });

        console.log(chalk.green('Mastodon への投稿が成功しました'));
    } catch (error) {
        console.error(chalk.red('投稿処理でエラーが発生しました:'), error);
        process.exitCode = 1;
    }
};

const isMainModule = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
    await main();
}
