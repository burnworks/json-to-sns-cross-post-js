# json-to-sns-cross-post-js

A Node.js script for cross-posting JSON data to X, Bluesky, and Mastodon.

JSONデータからX、Bluesky、Mastodonへ同じ内容を投稿するNode.jsスクリプトです。テキストだけでなく、最大4枚の画像と代替テキストを投稿できます。

## Requirements

- Node.js 22以上
- 投稿先SNSのアカウントとAPI認証情報

## Getting Started

```sh
git clone https://github.com/burnworks/json-to-sns-cross-post-js.git
cd json-to-sns-cross-post-js
npm install
```

`.env.sample`を`.env`へコピーし、利用するSNSの設定を入力してください。

```dotenv
## Bluesky
BSKY_SERVICE_URL=https://bsky.social
BSKY_IDENTIFIER=
BSKY_PASSWORD=

## Mastodon
MASTODON_ACCESS_TOKEN=
MASTODON_API_URL=https://mastodon.example.com/api/v1/

## X
X_OAUTH2_CLIENT_ID=
X_OAUTH2_CLIENT_SECRET=
X_CALLBACK_URL=https://example.com

## JSON path
POST_JSON_URL=json/sample.json
```

`POST_JSON_URL`には、プロジェクトルートからの相対パス、絶対パス、または`https://`から始まるURLを指定できます。

利用しないSNSの環境変数は空のままでも構いませんが、そのSNSの投稿コマンドは実行しないでください。

## Xの初回認証

Xへの投稿にはOAuth 2.0を使用します。X Developer ConsoleでOAuth 2.0を有効にし、Client ID、Client Secret、Callback URLを`.env`へ設定してください。

既定で次のスコープを要求します。

```text
tweet.read tweet.write users.read media.write offline.access
```

初回の`npm run post:x`では認可URLが表示されます。ブラウザで認可したあと、リダイレクト先のURL全体をターミナルへ貼り付けてください。取得したトークンは`.x-oauth-token.json`へ保存され、以後は再利用または自動更新されます。このファイルには認証情報が含まれるため、Gitへコミットしないでください。

必要な場合は次の環境変数で既定値を変更できます。

```dotenv
X_OAUTH_SCOPES=tweet.read tweet.write users.read media.write offline.access
X_TOKEN_CACHE_PATH=.x-oauth-token.json
```

`X_CALLBACK_URL`の代わりに`X_REDIRECT_URI`も使用できます。

## JSONデータ

投稿データは次の形式です。

```json
{
  "text": "投稿するテキストです。\nhttps://example.com/",
  "images": [
    {
      "src": "./images/example-01.png",
      "alt": "画像の代替テキスト"
    }
  ]
}
```

- `text`には投稿本文を指定します。文字数制限は各SNSに合わせてJSON作成時に調整してください。
- `images`は省略するか空配列にすると、テキストだけを投稿します。
- 添付画像は最大4枚です。
- `images.src`にはローカルパスまたは`http://`・`https://`の画像URLを指定できます。
- リモートJSONを使う場合、ローカル画像パスは実行環境から解決されます。別環境から参照できないパスを指定しないでください。
- `images.alt`は省略できます。指定した場合は画像の代替テキストとして送信されます。

サンプルは`json/sample.json`にあります。

## 投稿

3つのSNSへ順番に投稿します。

```sh
npm run post
```

実行順はX、Mastodon、Blueskyです。途中で失敗した場合、それより前のSNSには投稿済みになっている可能性があります。

SNSごとに個別実行することもできます。

```sh
npm run post:x
npm run post:mastodon
npm run post:bluesky
```

成功時は各SNSの「投稿が成功しました」というメッセージが表示されます。失敗時は終了コードが非ゼロになり、エラー内容が表示されます。

## Notes

- XではOAuth 2.0 PKCE、トークン更新、one-shot／chunked画像アップロードに対応しています。
- Mastodonではメディア処理の完了を待ってから投稿し、通信切断時の二重投稿を避けるためIdempotency-Keyを使用します。
- Blueskyでは本文中のリンクを解析し、取得できる場合はリンクカードを生成します。
- JSON生成画面はこの公開リポジトリには含まれていません。

## Links

- [Bluesky API Documentation](https://docs.bsky.app/)
- [Mastodon API documentation](https://docs.joinmastodon.org/api/)
- [X Developer Platform](https://developer.x.com/)
- [@xdevplatform/xdk](https://www.npmjs.com/package/@xdevplatform/xdk)
