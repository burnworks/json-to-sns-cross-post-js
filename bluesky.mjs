import atprotoApi from '@atproto/api';
const { BskyAgent, RichText } = atprotoApi;
import ogs from 'open-graph-scraper';
import sharp from 'sharp';
import { promises as fsPromises } from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import chalk from 'chalk';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

// 環境変数から設定を読み込む
const getConfig = (key, defaultValue = '') => process.env[key] || defaultValue;
const [service, identifier, password, jsonURL] = ['BSKY_SERVICE_URL', 'BSKY_IDENTIFIER', 'BSKY_PASSWORD', 'POST_JSON_URL'].map(key => getConfig(key));

// Agent の初期化とログイン処理
const initializeAndLogin = async () => {
    if (!service || !identifier || !password) {
        throw new Error('環境変数が正しく読み込めませんでした');
    }
    const agent = new BskyAgent({ service });
    await agent.login({ identifier, password });
    return agent;
};

// データURIを Uint8Array に変換するヘルパー関数
const convertDataURIToUint8Array = dataURI => {
    const base64 = dataURI.split(',')[1];
    return new Uint8Array(Buffer.from(base64, 'base64'));
};

// RichText から URL を取得
const findUrlInText = async (rt) => {
    for (const facet of rt.facets || []) {
        for (const feature of facet.features || []) {
            if (feature.$type === 'app.bsky.richtext.facet#link' && typeof feature.uri === 'string') {
                return feature.uri;
            }
        }
    }
    return null;
};

// Open Graph データの取得
const getOgInfo = async (url) => {
    try {
        const { result } = await ogs({ url: url });
        if (!result.success) {
            console.log(chalk.yellow('Open Graph データの取得に失敗したので処理をスキップしました'));
            return null;
        }

        const ogImageUrl = result.ogImage?.at(0)?.url || '';
        const res = await fetch(ogImageUrl);
        const buffer = await res.arrayBuffer();
        const mimeType = res.headers.get('Content-Type');

        // 画像の MIME Type に基づいて処理を分岐
        const ext = path.extname(new URL(ogImageUrl).pathname).toLowerCase();
        let imageOptions = { resize: { width: 800, fit: 'inside', withoutEnlargement: true } };
        if (mimeType === 'image/jpeg') {
            imageOptions = { ...imageOptions, format: 'jpeg', options: { quality: 80, progressive: true } };
        } else if (mimeType === 'image/png') {
            imageOptions = { ...imageOptions, format: 'png', options: { quality: 80 } };
        }

        const compressedImage = await sharp(buffer)
            .resize(imageOptions.resize)
        [imageOptions.format || 'toBuffer'](imageOptions.options || {})
            .toBuffer();

        return {
            siteUrl: url,
            ogImageUrl: ogImageUrl,
            type: mimeType,
            description: result.ogDescription || '',
            title: result.ogTitle || '',
            imageData: new Uint8Array(compressedImage),
        };
    } catch (error) {
        console.error(chalk.red('Open Graph データの取得中にエラーが発生しました:'), error);
        return null;
    }
};

// Open Graph データを使用して画像をアップロードし、Embed 用のデータを返す関数
const uploadImage = async (agent, ogInfo) => {
    const thumbnail = `data:${ogInfo.type};base64,${Buffer.from(ogInfo.imageData).toString('base64')}`;
    const { data } = await agent.uploadBlob(convertDataURIToUint8Array(thumbnail), {
        encoding: ogInfo.type,
    });

    return data;
};

// JSONを取得
const loadPostData = async () => {
    if (jsonURL.startsWith('http://') || jsonURL.startsWith('https://')) {
        const response = await fetch(jsonURL);
        if (!response.ok) {
            throw new Error(`HTTP エラー status: ${response.status}`);
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

// 投稿処理
const main = async () => {
    try {
        const agent = await initializeAndLogin();
        const postData = await loadPostData();
        const rt = new RichText({ text: postData.text });
        await rt.detectFacets(agent);

        let embed = null;

        // 投稿に画像が含まれている場合の処理
        if (postData.images && postData.images.length > 0) {
            const imageEmbeds = await Promise.all(postData.images.map(async (image) => {
                let buffer;
                // リモート画像の場合
                if (image.src.startsWith('http://') || image.src.startsWith('https://')) {
                    const response = await fetch(image.src);
                    if (!response.ok) throw new Error(`HTTP エラー status: ${response.status}`);
                    const arrayBuffer = await response.arrayBuffer();
                    buffer = Buffer.from(arrayBuffer);
                } else {
                    // ローカル画像の場合
                    const imagePath = path.resolve(__dirname, image.src);
                    buffer = await fsPromises.readFile(imagePath);
                }

                // sharpを使用して画像を処理（横幅800pxにリサイズ）
                const processedImage = await sharp(buffer)
                    .resize(800, null, { fit: "inside", withoutEnlargement: true })
                    .toBuffer({ resolveWithObject: true });

                const mimeType = `image/${processedImage.info.format}`;
                const dataURI = `data:${mimeType};base64,${processedImage.data.toString('base64')}`;

                const { data } = await agent.uploadBlob(convertDataURIToUint8Array(dataURI), {
                    encoding: mimeType,
                });

                return {
                    alt: image.alt,
                    image: data.blob,
                    aspectRatio: {
                        width: processedImage.info.width,
                        height: processedImage.info.height,
                    },
                };
            }));

            embed = { $type: 'app.bsky.embed.images', images: imageEmbeds };
        } else {
            // それ以外の処理
            const url = await findUrlInText(rt);
            if (url) {
                const ogInfo = await getOgInfo(url);
                if (ogInfo) {
                    const uploadedRes = await uploadImage(agent, ogInfo);
                    embed = {
                        $type: 'app.bsky.embed.external',
                        external: {
                            uri: ogInfo.siteUrl,
                            thumb: {
                                $type: 'blob',
                                ref: { $link: uploadedRes.blob.ref.toString() },
                                mimeType: uploadedRes.blob.mimeType,
                                size: uploadedRes.blob.size,
                            },
                            title: ogInfo.title,
                            description: ogInfo.description,
                        },
                    };
                }
            }
        }

        await agent.post({
            text: rt.text,
            facets: rt.facets,
            createdAt: new Date().toISOString(),
            langs: ['ja-JP', 'en-US'],
            ...(embed && { embed: embed }),
        });

        console.log(chalk.green('Bluesky への投稿が成功しました'));
    } catch (error) {
        console.error(chalk.red('投稿処理でエラーが発生しました:'), error);
    }
};

main();
