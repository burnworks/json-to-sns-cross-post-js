import {
    Client,
    OAuth2,
    generateCodeChallenge,
    generateCodeVerifier,
    generateNonce,
} from '@xdevplatform/xdk';
import { promises as fsPromises } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import chalk from 'chalk';

dotenv.config();

const getConfig = (key, defaultValue = '') => process.env[key] || defaultValue;
const getFirstConfig = (keys, defaultValue = '') => keys.map(key => getConfig(key)).find(Boolean) || defaultValue;

const xConfig = {
    clientId: getFirstConfig(['X_OAUTH2_CLIENT_ID', 'X_CLIENT_ID', 'X_API_CLIENT_ID', 'CLIENT_ID']),
    clientSecret: getFirstConfig(['X_OAUTH2_CLIENT_SECRET', 'X_CLIENT_SECRET', 'X_API_CLIENT_SECRET', 'CLIENT_SECRET']),
    redirectUri: getFirstConfig(['X_REDIRECT_URI', 'X_CALLBACK_URL', 'CALLBACK_URL'], 'https://example.com'),
    tokenCachePath: getConfig('X_TOKEN_CACHE_PATH', '.x-oauth-token.json'),
    postJsonUrl: getConfig('POST_JSON_URL', './json/sample.json'),
};

const defaultOAuthScopes = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
const oauthScopesConfig = getConfig('X_OAUTH_SCOPES');
const oauthScopes = oauthScopesConfig
    ? oauthScopesConfig.split(/[,\s]+/).filter(Boolean)
    : defaultOAuthScopes;

const requiredConfigKeys = [
    { label: 'X_CLIENT_ID または X_OAUTH2_CLIENT_ID', value: xConfig.clientId },
    { label: 'X_CLIENT_SECRET または X_OAUTH2_CLIENT_SECRET', value: xConfig.clientSecret },
];

const assertRequiredConfig = () => {
    const missingKeys = requiredConfigKeys.filter(({ value }) => !value).map(({ label }) => label);
    if (missingKeys.length > 0) {
        throw new Error(`環境変数が不足しています: ${missingKeys.join(', ')}`);
    }
};

const cleanMimeType = (mimeType) => mimeType.split(';')[0].trim().toLowerCase();

const getMimeTypeFromSharpFormat = (format, fallbackMimeType) => {
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
    return mimeTypes[format] || fallbackMimeType;
};

const getMediaCategory = (mimeType) => mimeType === 'image/gif' ? 'tweet_gif' : 'tweet_image';
const oneShotUploadMimeTypes = new Set([
    'image/bmp',
    'image/jpeg',
    'image/pjpeg',
    'image/png',
    'image/tiff',
    'image/webp',
]);
const uploadableMimeTypes = new Set([...oneShotUploadMimeTypes, 'image/gif']);
const oneShotMaxBytes = 5 * 1024 * 1024;
const uploadChunkBytes = 4 * 1024 * 1024;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getHttpStatus = (error) => error?.status || error?.statusCode || error?.code || error?.data?.status;
const isRetryableApiError = (error) => [429, 500, 502, 503, 504].includes(getHttpStatus(error));

const runStep = async (step, action) => {
    try {
        return await action();
    } catch (error) {
        if (error && typeof error === 'object' && !error.apiStep) {
            error.apiStep = step;
        }
        throw error;
    }
};

const runStepWithRetry = async (step, action, { retries = 2, delayMs = 1000 } = {}) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await runStep(step, action);
        } catch (error) {
            if (attempt >= retries || !isRetryableApiError(error)) {
                throw error;
            }
            const nextDelayMs = delayMs * (2 ** attempt);
            console.warn(chalk.yellow(`${step} が HTTP ${getHttpStatus(error)} で失敗したため、${nextDelayMs}ms 後に再試行します`));
            await sleep(nextDelayMs);
        }
    }
};

const safeStringify = (value) => {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const logPostError = (error) => {
    console.error(chalk.red('投稿処理でエラーが発生しました'));
    if (error?.apiStep) {
        console.error(chalk.yellow('失敗ステップ:'), error.apiStep);
    }
    if (error?.message) {
        console.error(chalk.yellow('エラー:'), error.message);
    }
    const status = getHttpStatus(error);
    if (typeof status !== 'undefined') {
        console.error(chalk.yellow('HTTP status:'), status);
    }
    if (error?.statusText) {
        console.error(chalk.yellow('HTTP status text:'), error.statusText);
    }
    if (error?.data) {
        console.error(chalk.yellow('X API response:'), safeStringify(error.data));
    }
    if (!error?.data && !error?.message) {
        console.error(error);
    }
};

const ask = async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
    }
};

const parseOAuthCallback = (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error('OAuth コールバック URL が空です');
    }
    if (!trimmed.includes('=') && !trimmed.includes('?') && !trimmed.includes('#')) {
        return { code: trimmed, state: undefined };
    }

    let params;
    try {
        const url = new URL(trimmed);
        params = new URLSearchParams(url.search);
        if (!params.has('code') && url.hash) {
            params = new URLSearchParams(url.hash.replace(/^#/, ''));
        }
    } catch {
        params = new URLSearchParams(trimmed.replace(/^[?#]/, ''));
    }

    const code = params.get('code');
    if (!code) {
        throw new Error('OAuth コールバック URL から code を取得できませんでした');
    }
    return { code, state: params.get('state') };
};

const getAccessTokenExpiresAt = (token) => {
    const expiresIn = Number(token?.expires_in);
    return Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined;
};

const readTokenCache = async () => {
    try {
        return JSON.parse(await fsPromises.readFile(xConfig.tokenCachePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
};

const writeTokenCache = async (token, expiresAt) => {
    await fsPromises.writeFile(xConfig.tokenCachePath, JSON.stringify({ token, expiresAt }, null, 2) + '\n');
};

const getTokenScopes = (token) => typeof token?.scope === 'string'
    ? token.scope.split(/\s+/).filter(Boolean)
    : [];

const assertTokenScopes = (token, requiredScopes, context) => {
    const tokenScopes = getTokenScopes(token);
    if (tokenScopes.length === 0) {
        return;
    }

    const tokenScopeSet = new Set(tokenScopes);
    const missingScopes = requiredScopes.filter(scope => !tokenScopeSet.has(scope));
    if (missingScopes.length > 0) {
        throw new Error(`${context} に必要な OAuth2 scope がありません: ${missingScopes.join(', ')}。現在の scope: ${tokenScopes.join(' ')}。Developer Console で生成した自分用トークンに scope がない場合は、環境変数の X_OAUTH2_ACCESS_TOKEN / X_OAUTH2_REFRESH_TOKEN と .x-oauth-token.json を外して、このスクリプトの OAuth 認可URLから取り直してください。`);
    }
};

const getEnvOAuthToken = () => {
    const accessToken = getFirstConfig(['X_ACCESS_TOKEN', 'X_OAUTH2_ACCESS_TOKEN']);
    if (!accessToken) {
        return null;
    }
    const expiresIn = getFirstConfig(['X_ACCESS_TOKEN_EXPIRES_IN', 'X_OAUTH2_ACCESS_TOKEN_EXPIRES_IN']);
    const expiresAt = getFirstConfig(['X_ACCESS_TOKEN_EXPIRES_AT', 'X_OAUTH2_ACCESS_TOKEN_EXPIRES_AT']);

    return {
        token: {
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: Number(expiresIn || '0'),
            refresh_token: getFirstConfig(['X_REFRESH_TOKEN', 'X_OAUTH2_REFRESH_TOKEN']) || undefined,
        },
        expiresAt: Number(expiresAt || '0') || undefined,
        hasExpiry: Boolean(expiresIn || expiresAt),
    };
};

const getOAuthToken = async () => {
    const oauth2 = new OAuth2({
        clientId: xConfig.clientId,
        clientSecret: xConfig.clientSecret,
        redirectUri: xConfig.redirectUri,
        scope: oauthScopes,
    });

    const cached = await readTokenCache();
    if (cached?.token?.access_token) {
        oauth2.setToken(cached.token, cached.expiresAt);
        if (!oauth2.isTokenExpired(300)) {
            return cached.token;
        }
        if (cached.token.refresh_token) {
            const refreshed = await runStep('OAuth2 token refresh', () => oauth2.refreshToken(cached.token.refresh_token));
            const token = {
                ...refreshed,
                refresh_token: refreshed.refresh_token || cached.token.refresh_token,
            };
            await writeTokenCache(token, getAccessTokenExpiresAt(token));
            return token;
        }
        console.warn(chalk.yellow('OAuth2 トークンは期限切れですが refresh_token がないため再認可します'));
    }

    const envToken = getEnvOAuthToken();
    if (envToken) {
        oauth2.setToken(envToken.token, envToken.expiresAt);
        if ((!envToken.hasExpiry || oauth2.isTokenExpired(300)) && envToken.token.refresh_token) {
            const refreshed = await runStep('OAuth2 token refresh', () => oauth2.refreshToken(envToken.token.refresh_token));
            const token = {
                ...refreshed,
                refresh_token: refreshed.refresh_token || envToken.token.refresh_token,
            };
            await writeTokenCache(token, getAccessTokenExpiresAt(token));
            return token;
        }
        await writeTokenCache(envToken.token, envToken.expiresAt);
        return envToken.token;
    }

    const state = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    await oauth2.setPkceParameters(codeVerifier, codeChallenge);

    const authUrl = await oauth2.getAuthorizationUrl(state);
    console.log(chalk.cyan('X の OAuth2 認可が必要です'));
    console.log(`Redirect URI: ${xConfig.redirectUri}`);
    console.log(`Authorize URL: ${authUrl}`);

    const callbackUrl = await ask('ブラウザで認可後、リダイレクト先 URL を貼り付けて Enter: ');
    const { code, state: returnedState } = parseOAuthCallback(callbackUrl);
    if (returnedState !== state) {
        throw new Error('OAuth state が一致しません');
    }

    const token = await runStep('OAuth2 code exchange', () => oauth2.exchangeCode(code, codeVerifier));
    await writeTokenCache(token, getAccessTokenExpiresAt(token));
    return token;
};

const createXClient = async () => {
    const token = await getOAuthToken();
    return {
        client: new Client({
            accessToken: token.access_token,
            timeout: 30000,
            maxRetries: 2,
        }),
        token,
    };
};

const fetchJSON = async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP エラー status: ${response.status}`);
    }
    return response.json();
};

const readLocalJSON = async (filePath) => JSON.parse(await fsPromises.readFile(filePath, 'utf8'));

const loadPostData = async (jsonURL) => (
    jsonURL.startsWith('http://') || jsonURL.startsWith('https://')
        ? fetchJSON(jsonURL)
        : readLocalJSON(jsonURL)
);

const getImageBufferAndType = async (imageSrc) => {
    if (imageSrc.startsWith('http://') || imageSrc.startsWith('https://')) {
        return await downloadImage(imageSrc);
    }
    const buffer = await fsPromises.readFile(imageSrc);
    const fileType = await fileTypeFromBuffer(buffer) || { mime: 'image/jpeg' };
    return { buffer, mimeType: cleanMimeType(fileType.mime) };
};

const downloadImage = async (imageSrc) => {
    const response = await fetch(imageSrc);
    if (!response.ok) {
        throw new Error(`画像をダウンロードできません: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
        buffer: Buffer.from(arrayBuffer),
        mimeType: cleanMimeType(response.headers.get('content-type') || 'image/jpeg'),
    };
};

const processImage = async (imageSrc) => {
    const { buffer, mimeType } = await getImageBufferAndType(imageSrc);
    if (mimeType === 'image/gif') {
        return { processedBuffer: buffer, mimeType };
    }

    const { data, info } = await sharp(buffer)
        .resize({ width: 800, fit: 'inside', withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });

    const processedMimeType = cleanMimeType(getMimeTypeFromSharpFormat(info.format, mimeType));
    if (uploadableMimeTypes.has(processedMimeType)) {
        return { processedBuffer: data, mimeType: processedMimeType };
    }

    return {
        processedBuffer: await sharp(buffer)
            .resize({ width: 800, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 88 })
            .toBuffer(),
        mimeType: 'image/jpeg',
    };
};

const extractMediaId = (response) => {
    const mediaId = response?.data?.id
        || response?.data?.mediaId
        || response?.id
        || response?.mediaId
        || response?.media_id_string
        || response?.media_id;
    if (!mediaId) {
        throw new Error(`media_id を取得できませんでした: ${safeStringify(response)}`);
    }
    return String(mediaId);
};

const getProcessingInfo = (response) => response?.data?.processingInfo || response?.data?.processing_info || response?.processingInfo;

const waitForMediaProcessing = async (client, mediaId, response) => {
    let processingInfo = getProcessingInfo(response);
    while (processingInfo) {
        const state = processingInfo.state;
        if (state === 'succeeded') {
            return;
        }
        if (state === 'failed') {
            throw new Error(`メディア処理に失敗しました: ${safeStringify(processingInfo)}`);
        }
        await sleep((Number(processingInfo.checkAfterSecs || processingInfo.check_after_secs) || 1) * 1000);
        const status = await runStepWithRetry(`画像処理状況確認: ${mediaId}`, () => client.media.getUploadStatus(mediaId));
        processingInfo = getProcessingInfo(status);
    }
};

const uploadMediaOneShot = async (client, processedBuffer, mimeType) => {
    const response = await client.media.upload({
        body: {
            media: processedBuffer.toString('base64'),
            mediaCategory: 'tweet_image',
            mediaType: mimeType,
        },
    });
    return extractMediaId(response);
};

const uploadMediaChunked = async (client, processedBuffer, mimeType) => {
    const initialized = await client.media.initializeUpload({
        body: {
            totalBytes: processedBuffer.length,
            mediaType: mimeType,
            mediaCategory: getMediaCategory(mimeType),
        },
    });
    const mediaId = extractMediaId(initialized);

    for (let offset = 0, segmentIndex = 0; offset < processedBuffer.length; offset += uploadChunkBytes, segmentIndex++) {
        await client.media.appendUpload(mediaId, {
            body: {
                media: processedBuffer.subarray(offset, offset + uploadChunkBytes).toString('base64'),
                segmentIndex,
            },
        });
    }

    const finalized = await client.media.finalizeUpload(mediaId);
    await waitForMediaProcessing(client, mediaId, finalized);
    return mediaId;
};

const uploadImage = async (client, image) => {
    const { processedBuffer, mimeType } = await processImage(image.src);
    if (!uploadableMimeTypes.has(mimeType)) {
        throw new Error(`X にアップロードできない MIME type です: ${mimeType}`);
    }

    const mediaId = oneShotUploadMimeTypes.has(mimeType) && processedBuffer.length <= oneShotMaxBytes
        ? await runStepWithRetry(`画像アップロード(one-shot): ${image.src}`, () => uploadMediaOneShot(client, processedBuffer, mimeType))
        : await runStepWithRetry(`画像アップロード(chunked): ${image.src}`, () => uploadMediaChunked(client, processedBuffer, mimeType));

    if (image.alt) {
        await runStepWithRetry(`画像ALT設定: ${image.src}`, () => client.media.createMetadata({
            body: {
                id: mediaId,
                metadata: {
                    alt_text: {
                        text: image.alt,
                    },
                },
            },
        }));
    }
    return mediaId;
};

const normalizeImages = (images) => Array.isArray(images)
    ? images.filter(image => image && typeof image.src === 'string' && image.src.trim())
    : [];

const main = async () => {
    try {
        assertRequiredConfig();

        const { client, token } = await runStep('X client 初期化', createXClient);
        const postData = await runStep('投稿JSON読み込み', () => loadPostData(xConfig.postJsonUrl));
        const images = normalizeImages(postData.images);

        if (!postData.text && images.length === 0) {
            throw new Error('投稿テキストまたは画像が必要です');
        }
        if (images.length > 0) {
            assertTokenScopes(token, ['media.write'], '画像アップロード');
        }

        const mediaIds = images.length > 0
            ? await Promise.all(images.map(image => uploadImage(client, image)))
            : [];

        const response = await runStep('Post作成: client.posts.create', () => client.posts.create({
            text: postData.text || '',
            ...(mediaIds.length > 0 && { media: { mediaIds } }),
        }));

        const postId = response?.data?.id ? ` ID: ${response.data.id}` : '';
        console.log(chalk.green(`X への投稿が成功しました${postId}`));
    } catch (error) {
        logPostError(error);
        process.exitCode = 1;
    }
};

main();
