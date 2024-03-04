# json-to-sns-cross-post-js 

A script for cross-posting to social networks like Twitter, Bluesky, and Mastodon from JSON data.

JSON データから Twitter, Bluesky, Mastodon などの SNS にクロスポストする JavaScript（Node.js）です。

## Getting Started

Install Node.js if you haven't already.

Node.js v16 や v18 でも動作すると思いますが、v20.x 環境でしか動作テストしていないため、なるべく最新の Node.js を使用してください。

```sh
git clone https://github.com/burnworks/json-to-sns-cross-post-js.git
cd json-to-sns-cross-post-js
npm install
```

## .env

`.env.sample` を `.env` にリネームしてから各環境変数を記述して保存してください。

```
## Bluesky
BSKY_SERVICE_URL=【BlueskyでログインするURL 例）https://bsky.social】
BSKY_IDENTIFIER=【ログインユーザーのメールアドレス】
BSKY_PASSWORD=【アプリパスワード（管理画面から取得可能）】

## Mastodon
MASTODON_ACCESS_TOKEN=【アクセストークン（管理画面から取得可能）】
MASTODON_API_URL=【APIのURL 例）https://mastodon.example.com/api/v1/】

## X (Teitter)
X_API_KEY=【API キー】
X_API_KEY_SECRET=【API secret key】
X_ACCESS_TOKEN=【Access Token】
X_ACCESS_TOKEN_SECRET=【Access Token Secret】

## JSON path (e.g. 'json/sample.json' or 'https://example.com/json/sample.json')
POST_JSON_URL=json/sample.json
```

`POST_JSON_URL` は

- ローカル環境に置いた JSON ファイルならプロジェクトルートディレクトリからの相対パスを
- Web上にあるJSONなら `https://` から始まる URL を

設定します。

## JSON データ

投稿に使用する JSON データの形式は下記の通りです。

```json
{
    "text": "投稿するテキスト\n改行は改行コードに\n\nURLもテキストとして入れられます。\nhttps://example.com/",
    "images": [
        {
            "src": "./images/example-01.png",
            "alt": "代替テキスト01"
        },
        {
            "src": "./images/example-02.png",
            "alt": "代替テキスト01"
        },
        {
            "src": "./images/example-03.png",
            "alt": "代替テキスト03"
        },
        {
            "src": "./images/example-04.png",
            "alt": "代替テキスト04"
        }
    ]
}
```

`images` は、最大で 4 つまでの画像を投稿に添付できるようにしています。

テキストのみの投稿の場合は `images` を空にしてください。（`"images": []`）、あるいは `images` 自体を削除しても良いです。

`images.src` は、

- JSON をローカル環境に置く場合は、プロジェクトルートディレクトリからの相対パスでもよいですし、`https://` から始まる URL を入れても問題ありません。画像ごとに相対パスと URL が混在していても大丈夫です。
- JSON をリモートの Web 上に置く場合は、`https://` から始まる画像の URL のみ入力可能です。

`images.alt` は、空でもよいです。テキストが入った場合は、画像の代替テキストとして送信されます。

## 投稿

各環境変数が正しく設定され、JSON の内容に問題がないことを確認後、下記のコマンドで各スクリプトが実行されます。

```sh
npm run post
```

「投稿が成功しました」とログが表示されれば成功しています。エラーの場合はエラーログの内容を確認してください。

`package.json` の内容は下記の通りです。もし使用していないSNSがある場合は、`post:**` を必要に応じて削除するなどしてください。

```json
"scripts": {
  "post": "run-s post:*",
  "post:x": "node x.mjs",
  "post:mastodon": "node mastodon.mjs",
  "post:bluesky": "node bluesky.mjs"
},
```

## リンク

### Bluesky
- [Bluesky API Documentation](https://docs.bsky.app/)
- [atproto/packages/api](https://github.com/bluesky-social/atproto/tree/main/packages/api)

### Mastodon
- [statuses API methods - Mastodon documentation](https://docs.joinmastodon.org/methods/statuses/)
- [vanita5/mastodon-api: Mastodon API Client Library](https://github.com/vanita5/mastodon-api)

### X (Twitter)
- [Twitter API Documentation](https://developer.twitter.com/en/docs/twitter-api)
- [PLhery/node-twitter-api-v2](https://github.com/plhery/node-twitter-api-v2)

## メモ

- mastodon-api がメンテされてないっぽいのが気になる
- JSON を取得しにいく部分とかは各スクリプトに個別に実装するんじゃなく共通コード化した方がいいと思うけど面倒くさいので今はよし
