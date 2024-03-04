import { TwitterApi } from 'twitter-api-v2';
import { promises as fsPromises } from 'fs';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import chalk from 'chalk';

dotenv.config();

// 環境変数から設定を読み込む
const getConfig = (key, defaultValue = '') => process.env[key] || defaultValue;

// インスタンスを作成
const twitterClient = new TwitterApi({
    appKey: getConfig('X_API_KEY'),
    appSecret: getConfig('X_API_KEY_SECRET'),
    accessToken: getConfig('X_ACCESS_TOKEN'),
    accessSecret: getConfig('X_ACCESS_TOKEN_SECRET'),
});

// リモートのJSONを取得
const fetchJSON = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP エラー status: ${response.status}`);
    return response.json();
}

// ローカルのJSONを取得
const readLocalJSON = async (filePath) => JSON.parse(await fsPromises.readFile(filePath, 'utf8'));

// JSONを取得
const loadPostData = async (jsonURL) => jsonURL.startsWith('http://') || jsonURL.startsWith('https://') ? fetchJSON(jsonURL) : readLocalJSON(jsonURL);

const processImage = async (imageSrc) => {
    const { buffer, mimeType } = await getImageBufferAndType(imageSrc);
    const processedBuffer = await sharp(buffer).resize(800).toBuffer();
    return { processedBuffer, mimeType };
};

const getImageBufferAndType = async (imageSrc) => {
    if (imageSrc.startsWith('http://') || imageSrc.startsWith('https://')) {
        return await downloadImage(imageSrc);
    } else {
        const buffer = await fsPromises.readFile(imageSrc);
        const fileType = await fileTypeFromBuffer(buffer) || { mime: 'image/jpeg' };
        return { buffer, mimeType: fileType.mime };
    }
};

// 画像を取得
const downloadImage = async (imageSrc) => {
    const response = await fetch(imageSrc);
    if (!response.ok) throw new Error(`画像をダウンロードできません: ${response.statusText}`);
    return { buffer: await response.arrayBuffer(), mimeType: response.headers.get('content-type') || 'image/jpeg' };
};

const uploadImage = async (image) => {
    const { processedBuffer, mimeType } = await processImage(image.src);
    // 画像をアップロードしてメディアIDを取得
    const mediaId = await twitterClient.v1.uploadMedia(processedBuffer, { mimeType: mimeType });
    // 画像に代替テキストを設定
    if (image.alt) await twitterClient.v1.createMediaMetadata(mediaId, { alt_text: { text: image.alt } });
    return mediaId;
};

// 投稿処理
const main = async () => {
    try {
        // JSONから投稿データを読み込む
        const postData = await loadPostData(getConfig('POST_JSON_URL'));

        let mediaIds = [];
        // 画像つき投稿の場合のみ実行
        if (postData.images && postData.images.length > 0) {
            mediaIds = await Promise.all(postData.images.map(uploadImage));
        }

        // JSONからテキストを取得し、テキストと画像を含むツイートを投稿
        await twitterClient.v2.tweet({
            text: postData.text,
            ...(mediaIds.length > 0 && { media: { media_ids: mediaIds } }),
        });

        console.log(chalk.green('X への投稿が成功しました'));
    } catch (error) {
        console.error(chalk.red('投稿処理でエラーが発生しました:'), error);
    }
}

main();
