'use strict';
/**
 * 测试用的聊天记录样本（不是给用户看的「示例」，界面里已经没有任何示例入口）。
 * 三行走完四种格式 + 跨年 + 非文本消息 + 系统提示。
 */

const HEADER_STYLE = `aurora: 10-08 18:52:10
你明天几点到

aurora: 10-08 18:52:31
我下午没课

Celestine-Lux: 10-08 18:55:02
大概三点多吧

Celestine-Lux: 10-08 18:55:14
你干嘛

aurora: 10-08 18:56:40
没干嘛啊

aurora: 10-08 18:57:02
就是问问

aurora: 10-08 19:01:50
不是这个

aurora: 10-08 19:02:08
你有的时候不方便也是意识到什么的

aurora: 10-08 19:02:19
等你过来天天穿吧

Celestine-Lux: 10-08 19:02:31
豬吧

Celestine-Lux: 10-08 19:02:42
你腦子呢

aurora: 10-08 19:02:55
才不是猪

aurora: 10-08 19:03:05
抱抱宝宝

Celestine-Lux: 10-08 19:03:07
怎麼最近和豬一樣

aurora: 10-08 19:03:40
因为想你了

aurora: 10-08 19:03:52
[动画表情]

Celestine-Lux: 10-08 19:05:20
哦

aurora: 10-08 19:06:02
你是不是在忙

Celestine-Lux: 10-08 19:41:33
刚在打游戏

Celestine-Lux: 10-08 19:41:40
怎么了

aurora: 10-08 19:42:11
没事

aurora: 10-08 19:42:20
你玩吧

Celestine-Lux: 10-08 19:43:05
好

aurora: 10-08 23:47:12
睡了吗

aurora: 10-08 23:47:30
刚刚那部电影我一个人看完了

aurora: 10-08 23:47:44
结局有点想哭

Celestine-Lux: 10-09 00:12:55
还没

Celestine-Lux: 10-09 00:13:02
明天陪你重新看一遍？

aurora: 10-09 00:13:20
你不是看过了吗

Celestine-Lux: 10-09 00:13:33
再看一遍怎么了

aurora: 10-09 00:13:41
好呀

aurora: 10-09 00:13:55
那你不许中途睡着

aurora: 10-09 00:14:02
晚安

Celestine-Lux: 10-09 00:14:20
晚安
`;

const FULL_TS_STYLE = `2024-10-08 19:01:50 aurora
你好

2024-10-08 19:02:05 我
在的
`;

const BRACKET_STYLE = `[2024-10-08 19:01:50] aurora
你好
[2024-10-08 19:02:05] 我
在的
`;

const INLINE_TS_STYLE = `aurora 2024/10/8 19:01
在吗
我 2024/10/8 19:03
在
`;

const FILE_STYLE = `==============================
聊天记录
==============================

[图片]

aurora: 10-08 19:01:50
这个是你上次说的那家店吗

"aurora" 撤回了一条消息

aurora: 10-08 19:02:30
算了没什么

[语音]

Celestine-Lux: 10-08 19:05:10
哪家
`;

/** 供测试使用的行内小样本（标题前置格式） */
const LINE_STYLE = HEADER_STYLE;

module.exports = {
  HEADER_STYLE,
  LINE_STYLE,
  FULL_TS_STYLE,
  BRACKET_STYLE,
  INLINE_TS_STYLE,
  FILE_STYLE,
};
