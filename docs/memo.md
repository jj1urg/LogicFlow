# 人間のメモ

## about develop management

* Cloudflare Workersを使って、mainブランチの内容がそのまま https://logicflow.arrow-xt.com で使えるようになっているので、それについて明記をお願いしたい

## about fixes

* DFFとResisterにEN入力が存在してしまっているので、自動生成で特にEN入力がはいインピーダンスになってしまっており、クロックを入力しても値を更新できない
    * nビット全加算機のようにモジュールにENピンの有効、無効の設定項目を追加する必要がある
* Cloudflare Workersでビルドが行われない
    * ビルド失敗とかではなく、Github上にいるWorkers BuildsがAll checks have failedというエラーを吐いている

## aboud features

* PWA有効化の検討
* 新規モジュールについて、最初からHDLで制作できる機能