'use strict';

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const guild = (name, description) => new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
const taskOption = (o, required = true) => o.setName('task').setDescription('Task number (#)').setRequired(required).setAutocomplete(true).setMinValue(1);
const roleOption = (o) => o.setName('role').setDescription('Role (leave empty to clear)');

function pointOptions(builder, suffix = '') {
  for (const action of ['like', 'repost', 'reply', 'quote', 'bonus']) {
    builder.addIntegerOption((o) => o.setName(`${action}${suffix}`).setDescription(action === 'bonus' ? 'Bonus for completing every action' : `Points for each verified ${action}`).setMinValue(0).setMaxValue(1000));
  }
  return builder;
}

function commandsJSON() {
  const commands = [
    guild('link', 'Link your X (Twitter) account to participate in tasks')
      .addStringOption((o) => o.setName('user').setDescription('Your X username, for example @yourname').setRequired(true).setMaxLength(60)),
    guild('unlink', 'Unlink your X account from Discord'),
    guild('profile', 'Show points, streak and trust level')
      .addUserOption((o) => o.setName('member').setDescription('Member to view (defaults to you)')),
    guild('tasks', 'List active tasks and your remaining actions'),
    guild('verify', 'Verify a task, or submit a revised reply for review')
      .addIntegerOption((o) => taskOption(o, false))
      .addStringOption((o) => o.setName('reply').setDescription('Link to your reply on X').setMaxLength(300))
      .addStringOption((o) => o.setName('quote').setDescription('Link to your quote on X').setMaxLength(300)),
    guild('proof', 'Upload a screenshot as evidence of a like or repost')
      .addIntegerOption((o) => taskOption(o))
      .addStringOption((o) => o.setName('action').setDescription('Action shown in the screenshot').setRequired(true).addChoices({ name: 'Like', value: 'like' }, { name: 'Repost', value: 'repost' }))
      .addAttachmentOption((o) => o.setName('image').setDescription('Screenshot (PNG/JPG/WEBP/GIF, up to 8 MB)').setRequired(true)),
    guild('ranking', 'Show the server points leaderboard')
      .addStringOption((o) => o.setName('period').setDescription('Time period').addChoices({ name: 'Last 7 days', value: 'week' }, { name: 'Last 30 days', value: 'month' }, { name: 'All time', value: 'all' })),
    guild('help', 'How the bot works and available commands'),
    guild('task', 'Manage engagement tasks (staff)')
      .addSubcommand((s) => pointOptions(s.setName('create').setDescription('Publish an X post as a task with optional custom rewards')
        .addStringOption((o) => o.setName('url').setDescription('Link to the X post').setRequired(true).setMaxLength(300))
        .addBooleanOption((o) => o.setName('like').setDescription('Require a like'))
        .addBooleanOption((o) => o.setName('repost').setDescription('Require a repost'))
        .addBooleanOption((o) => o.setName('reply').setDescription('Require a reply'))
        .addBooleanOption((o) => o.setName('quote').setDescription('Require a quote'))
        .addStringOption((o) => o.setName('duration').setDescription('For example 30m, 2h, 1d (uses server default if omitted)').setMaxLength(20))
        .addNumberOption((o) => o.setName('multiplier').setDescription('Multiply default points (use instead of individual point values)').setMinValue(0.1).setMaxValue(20))
        .addChannelOption((o) => o.setName('channel').setDescription('Channel to publish in').addChannelTypes(...TEXT_CHANNELS))
        .addRoleOption((o) => o.setName('participants').setDescription('Role expected to participate'))
        .addRoleOption((o) => o.setName('mention').setDescription('Role to mention when publishing'))
        .addStringOption((o) => o.setName('note').setDescription('Extra instructions for members').setMaxLength(500)), '-points'))
      .addSubcommand((s) => s.setName('status').setDescription('Show participation in a task').addIntegerOption((o) => taskOption(o)))
      .addSubcommand((s) => s.setName('close').setDescription('Close a task and publish its report').addIntegerOption((o) => taskOption(o)))
      .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a task without a report').addIntegerOption((o) => taskOption(o)))
      .addSubcommand((s) => s.setName('remind').setDescription('Remind members who still have actions to complete').addIntegerOption((o) => taskOption(o)))
      .addSubcommand((s) => s.setName('extend').setDescription('Extend an active task').addIntegerOption((o) => taskOption(o))
        .addStringOption((o) => o.setName('time').setDescription('For example 30m or 1h').setRequired(true).setMaxLength(20))),
    guild('member', 'Manage members (staff)')
      .addSubcommand((s) => s.setName('points').setDescription('Add or subtract points for a member')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('Positive adds points, negative subtracts').setRequired(true).setMinValue(-100000).setMaxValue(100000))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(200)))
      .addSubcommand((s) => s.setName('block').setDescription('Block a member from participating').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)))
      .addSubcommand((s) => s.setName('unblock').setDescription('Allow a member to participate again').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)))
      .addSubcommand((s) => s.setName('link').setDescription('Manually link an X account for a member')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('account').setDescription('X username').setRequired(true).setMaxLength(60)))
      .addSubcommand((s) => s.setName('unlink').setDescription('Unlink an X account for a member').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))),
    pointOptions(guild('points', 'Set default rewards for future X posts (administrators)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)),
    guild('config', 'Configure this server (administrators)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('view').setDescription('Show current settings'))
      .addSubcommand((s) => s.setName('channel').setDescription('Set the default task channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('logs').setDescription('Set the staff log and review channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel (leave empty to disable)').addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('participant-role').setDescription('Role expected to participate').addRoleOption(roleOption))
      .addSubcommand((s) => s.setName('staff-role').setDescription('Role allowed to manage tasks').addRoleOption(roleOption))
      .addSubcommand((s) => s.setName('mention-role').setDescription('Role mentioned when publishing a task').addRoleOption(roleOption))
      .addSubcommand((s) => s.setName('verification').setDescription('Set like and repost verification')
        .addStringOption((o) => o.setName('mode').setDescription('Verification mode').setRequired(true).addChoices({ name: 'Declaration with public counter audit', value: 'declared' }, { name: 'Screenshot required', value: 'screenshot' }, { name: 'Staff review', value: 'review' })))
      .addSubcommand((s) => s.setName('quality').setDescription('Reply quality threshold for staff review (no automatic penalty)')
        .addIntegerOption((o) => o.setName('minimum').setDescription('Review threshold (0 disables quality review)').setRequired(true).setMinValue(0).setMaxValue(100)))
      .addSubcommand((s) => s.setName('reminders').setDescription('Remind members before a task ends')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Enable or disable reminders').setRequired(true))
        .addIntegerOption((o) => o.setName('minutes').setDescription('Minutes before the task ends').setMinValue(1).setMaxValue(1440))
        .addStringOption((o) => o.setName('mode').setDescription('Where to send reminders').addChoices({ name: 'Channel', value: 'channel' }, { name: 'Direct message', value: 'dm' }, { name: 'Both', value: 'both' })))
      .addSubcommand((s) => pointOptions(s.setName('points').setDescription('Set default points for future tasks')))
      .addSubcommand((s) => s.setName('duration').setDescription('Set the default task duration')
        .addStringOption((o) => o.setName('time').setDescription('For example 45m, 2h or 1d').setRequired(true).setMaxLength(20))),
  ];
  return commands.map((command) => command.toJSON());
}

module.exports = { commandsJSON };
