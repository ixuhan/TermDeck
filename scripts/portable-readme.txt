TermDeck 便携版
===============

绿色免安装。双击 TermDeck.exe 即可运行。

数据位置
--------
所有数据都保存在本目录下的 data\ 子目录中：

  data\workspace_state.json   会话树、窗口布局、快捷指令快照
  data\termdeck.db            SQLite 命令历史库
  data\settings.json          应用设置
  data\presets.json           预设库
  data\exports\               导出的指令集
  data\termdeck.log           运行日志

换台机器时整个文件夹拷走即可，历史和配置跟着一起走。
删除 data\ 目录等于恢复出厂设置。

系统要求
--------
Windows 10 1809 及以上 / Windows 11（x64）。
需要 WebView2 运行时 —— Windows 11 自带，Windows 10 若缺失请安装
Microsoft Edge WebView2 Evergreen Runtime。

常用快捷键
----------
Enter            执行命令
Shift + Enter    输入框内换行
Tab / →          采纳灰色预测补全
Ctrl + →         按词采纳补全
Ctrl + R         打开历史检索
Ctrl + Shift + P 切换「输入框模式 / 原生直通模式」
Ctrl + Shift + T 新建会话
Ctrl + Tab       切换会话

卸载
----
直接删除整个文件夹。
