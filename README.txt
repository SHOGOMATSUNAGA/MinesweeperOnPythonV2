Mines Duel

公開URLでオンライン対戦する方法

Renderに置く場合:
1. outputs フォルダの中身をGitHubリポジトリに入れる
2. Renderで New + > Web Service を選ぶ
3. そのGitHubリポジトリを選ぶ
4. Build Command は空のまま
5. Start Command は npm start
6. Deploy後に表示される https://... のURLを2人で開く
7. 片方が Create Room
8. もう片方が Room code を入力して Join

ローカル/LANで試す方法

1. start-server.bat を開く
2. 表示された http://...:4174/ を2台の端末で開く
3. 片方で Create Room
4. もう片方で Room code を入力して Join

注意:
部屋情報はサーバーのメモリ上に保存されます。無料ホスティングでサーバーが再起動すると部屋は消えます。
