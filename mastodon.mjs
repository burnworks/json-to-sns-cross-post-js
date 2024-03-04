import Mastodon from 'mastodon-api';
import { promises as fsPromises } from 'fs';
import fs from 'fs';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import chalk from 'chalk';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

// temp フォルダのパスを設定
const tempFolderPath = path.join(__dirname, '.temp');

// 環境変数から設定を読み込む
const getConfig = (key, defaultValue = '') => process.env[key] || defaultValue;

// Mastodon インスタンスを作成
const M = new Mastodon({
    access_token: getConfig('MASTODON_ACCESS_TOKEN'),
    api_url: getConfig('MASTODON_API_URL'),
    timeout_ms: 60 * 1000,
});

const jsonURL = getConfig('POST_JSON_URL');

// JSONを取得
const loadPostData = async () => {
    if (jsonURL.startsWith('http://') || jsonURL.startsWith('https://')) {
        const response = await fetch(jsonURL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    }
    // ローカルファイルの場合
    try {
        return JSON.parse(await fsPromises.readFile(jsonURL, 'utf8'));
    } catch (error) {
        console.error(chalk.red('JSONデータの取得中にエラーが発生しました:'), error);
        throw error;
    }
};

// 画像の処理
const uploadImage = async (image) => {
    let buffer;
    let tempFilePath;

    // temp フォルダが存在しない場合は作成
    await fsPromises.access(tempFolderPath).catch(() => fsPromises.mkdir(tempFolderPath, { recursive: true }));

    try {
        if (image.src.startsWith('http://') || image.src.startsWith('https://')) {
            // リモート画像をバッファとしてダウンロード
            const response = await fetch(image.src);
            if (!response.ok) throw new Error(`画像をダウンロードできません: ${response.statusText}`);
            const arrayBuffer = await response.arrayBuffer();
            buffer = Buffer.from(arrayBuffer);

        } else {
            // ローカルファイルをバッファとして読み込み
            buffer = await fs.promises.readFile(path.join(__dirname, image.src));
        }

        // 画像の拡張子を取得（デフォルト値は .jpg）
        const extension = path.extname(image.src).toLowerCase() || '.jpg';
        // 一時ファイルのパスを生成
        const tempFileName = `image-${Date.now()}${extension}`;
        tempFilePath = path.join(tempFolderPath, tempFileName);

        // sharp を使用して画像を横幅 800px にリサイズし、一時ファイルに保存
        await sharp(buffer)
            .resize(800, null, { fit: 'inside', withoutEnlargement: true })
            .toFile(tempFilePath);

        // 画像をアップロード
        const resp = await M.post('media', { file: fs.createReadStream(tempFilePath), description: image.alt });
        return resp.data.id;
    } catch (error) {
        console.error(chalk.red('画像のアップロードに失敗しました:'), error);
        throw error;
    } finally {
        // 使用後は一時ファイルを削除
        fsPromises.unlink(tempFilePath).catch(error => console.error(chalk.red('一時ファイルの削除に失敗しました:'), error));
    }
};

// 投稿処理
const main = async () => {
    try {
        const postData = await loadPostData();
        if (postData && postData.images && postData.images.length > 0) {
            const media_ids = await Promise.all(postData.images.map(image => uploadImage(image)));
            await M.post('statuses', { status: postData.text, media_ids });
        } else {
            await M.post('statuses', { status: postData.text });
        }

        console.log(chalk.green('Mastodon への投稿が成功しました'));
    } catch (error) {
        console.error(chalk.red('投稿処理でエラーが発生しました:'), error);
    }
};

main();
