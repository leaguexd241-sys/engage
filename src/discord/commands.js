'use strict';

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, InteractionContextType } = require('discord.js');

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const taskOption = (o, required = true) =>
  o.setName('tarea').setDescription('Número de la tarea (#)').setRequired(required).setAutocomplete(true).setMinValue(1);

function build() {
  const guildOnly = (b) => b.setContexts(InteractionContextType.Guild);

  const vincular = guildOnly(
    new SlashCommandBuilder()
      .setName('vincular')
      .setDescription('Vincula tu cuenta de X (Twitter) para participar en las tareas')
      .addStringOption((o) => o.setName('usuario').setDescription('Tu usuario de X, por ejemplo @tuusuario').setRequired(true).setMaxLength(60)),
  );

  const desvincular = guildOnly(new SlashCommandBuilder().setName('desvincular').setDescription('Quita la cuenta de X vinculada a tu Discord'));

  const perfil = guildOnly(
    new SlashCommandBuilder()
      .setName('perfil')
      .setDescription('Muestra puntos, racha y nivel de confianza')
      .addUserOption((o) => o.setName('miembro').setDescription('Miembro a consultar (por defecto, tú)')),
  );

  const tareas = guildOnly(new SlashCommandBuilder().setName('tareas').setDescription('Lista las tareas activas y cuáles te faltan'));

  const verificar = guildOnly(
    new SlashCommandBuilder()
      .setName('verificar')
      .setDescription('Verifica tu participación en una tarea (igual que el botón ✅)')
      .addIntegerOption((o) => taskOption(o, false))
      .addStringOption((o) => o.setName('comentario').setDescription('Enlace de tu comentario en X').setMaxLength(300))
      .addStringOption((o) => o.setName('cita').setDescription('Enlace de tu cita en X').setMaxLength(300)),
  );

  const prueba = guildOnly(
    new SlashCommandBuilder()
      .setName('prueba')
      .setDescription('Sube una captura como prueba de like o repost')
      .addIntegerOption((o) => taskOption(o))
      .addStringOption((o) =>
        o
          .setName('accion')
          .setDescription('¿Qué demuestra la captura?')
          .setRequired(true)
          .addChoices({ name: '❤️ Like', value: 'like' }, { name: '🔁 Repost', value: 'repost' }),
      )
      .addAttachmentOption((o) => o.setName('imagen').setDescription('Captura de pantalla (PNG/JPG, máx. 8 MB)').setRequired(true)),
  );

  const ranking = guildOnly(
    new SlashCommandBuilder()
      .setName('ranking')
      .setDescription('Clasificación de puntos del servidor')
      .addStringOption((o) =>
        o
          .setName('periodo')
          .setDescription('Periodo')
          .addChoices({ name: 'Últimos 7 días', value: 'semana' }, { name: 'Últimos 30 días', value: 'mes' }, { name: 'Siempre', value: 'todo' }),
      ),
  );

  const ayuda = guildOnly(new SlashCommandBuilder().setName('ayuda').setDescription('Cómo funciona el bot y lista de comandos'));

  const panel = guildOnly(new SlashCommandBuilder().setName('panel').setDescription('Enlace al panel web de control (staff)'));

  const tarea = guildOnly(
    new SlashCommandBuilder()
      .setName('tarea')
      .setDescription('Gestiona las tareas de engagement (staff)')
      .addSubcommand((s) =>
        s
          .setName('crear')
          .setDescription('Publica una tarea nueva para un post de X')
          .addStringOption((o) => o.setName('enlace').setDescription('Enlace del post de X').setRequired(true).setMaxLength(300))
          .addBooleanOption((o) => o.setName('like').setDescription('Pedir like'))
          .addBooleanOption((o) => o.setName('repost').setDescription('Pedir repost'))
          .addBooleanOption((o) => o.setName('comentario').setDescription('Pedir comentario'))
          .addBooleanOption((o) => o.setName('cita').setDescription('Pedir cita (quote)'))
          .addStringOption((o) => o.setName('duracion').setDescription('Ej.: 30m, 2h, 1d (por defecto, lo configurado)').setMaxLength(20))
          .addNumberOption((o) => o.setName('multiplicador').setDescription('Multiplica los puntos de esta tarea (ej.: 2 = doble)').setMinValue(0.1).setMaxValue(20))
          .addChannelOption((o) => o.setName('canal').setDescription('Canal donde publicarla').addChannelTypes(...TEXT_CHANNELS))
          .addRoleOption((o) => o.setName('participantes').setDescription('Rol que debe hacerla (para saber quién falta)'))
          .addRoleOption((o) => o.setName('mencionar').setDescription('Rol a mencionar al publicarla'))
          .addStringOption((o) => o.setName('nota').setDescription('Instrucciones extra para los miembros').setMaxLength(500)),
      )
      .addSubcommand((s) => s.setName('estado').setDescription('Quién hizo y quién no hizo la tarea').addIntegerOption((o) => taskOption(o)))
      .addSubcommand((s) => s.setName('cerrar').setDescription('Cierra la tarea ahora y publica el informe').addIntegerOption((o) => taskOption(o)))
      .addSubcommand((s) => s.setName('cancelar').setDescription('Cancela la tarea sin informe').addIntegerOption((o) => taskOption(o)))
      .addSubcommand((s) => s.setName('recordar').setDescription('Recuerda la tarea a quienes no la han hecho').addIntegerOption((o) => taskOption(o)))
      .addSubcommand((s) =>
        s
          .setName('extender')
          .setDescription('Amplía el tiempo de una tarea activa')
          .addIntegerOption((o) => taskOption(o))
          .addStringOption((o) => o.setName('tiempo').setDescription('Ej.: 30m, 1h').setRequired(true).setMaxLength(20)),
      ),
  );

  const miembro = guildOnly(
    new SlashCommandBuilder()
      .setName('miembro')
      .setDescription('Gestiona miembros (staff)')
      .addSubcommand((s) =>
        s
          .setName('puntos')
          .setDescription('Suma o resta puntos a un miembro')
          .addUserOption((o) => o.setName('usuario').setDescription('Miembro').setRequired(true))
          .addIntegerOption((o) => o.setName('cantidad').setDescription('Positivo suma, negativo resta').setRequired(true).setMinValue(-100000).setMaxValue(100000))
          .addStringOption((o) => o.setName('motivo').setDescription('Motivo').setMaxLength(200)),
      )
      .addSubcommand((s) =>
        s
          .setName('bloquear')
          .setDescription('Impide que un miembro participe en tareas')
          .addUserOption((o) => o.setName('usuario').setDescription('Miembro').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('desbloquear')
          .setDescription('Permite de nuevo participar a un miembro')
          .addUserOption((o) => o.setName('usuario').setDescription('Miembro').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('vincular')
          .setDescription('Vincula manualmente una cuenta de X a un miembro')
          .addUserOption((o) => o.setName('usuario').setDescription('Miembro').setRequired(true))
          .addStringOption((o) => o.setName('cuenta').setDescription('Usuario de X').setRequired(true).setMaxLength(60)),
      )
      .addSubcommand((s) =>
        s
          .setName('desvincular')
          .setDescription('Quita la cuenta de X de un miembro')
          .addUserOption((o) => o.setName('usuario').setDescription('Miembro').setRequired(true)),
      ),
  );

  const config = guildOnly(
    new SlashCommandBuilder()
      .setName('config')
      .setDescription('Configuración del bot en este servidor (administradores)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('ver').setDescription('Muestra la configuración actual'))
      .addSubcommand((s) =>
        s
          .setName('canal')
          .setDescription('Canal donde se publican las tareas')
          .addChannelOption((o) => o.setName('canal').setDescription('Canal').setRequired(true).addChannelTypes(...TEXT_CHANNELS)),
      )
      .addSubcommand((s) =>
        s
          .setName('logs')
          .setDescription('Canal de registro y revisiones del staff')
          .addChannelOption((o) => o.setName('canal').setDescription('Canal (vacío = desactivar)').addChannelTypes(...TEXT_CHANNELS)),
      )
      .addSubcommand((s) =>
        s
          .setName('rol-participantes')
          .setDescription('Rol que debe hacer las tareas (para saber quién falta)')
          .addRoleOption((o) => o.setName('rol').setDescription('Rol (vacío = quitar)')),
      )
      .addSubcommand((s) =>
        s
          .setName('rol-staff')
          .setDescription('Rol que puede gestionar tareas')
          .addRoleOption((o) => o.setName('rol').setDescription('Rol (vacío = quitar)')),
      )
      .addSubcommand((s) =>
        s
          .setName('rol-mencion')
          .setDescription('Rol que se menciona al publicar una tarea')
          .addRoleOption((o) => o.setName('rol').setDescription('Rol (vacío = no mencionar)')),
      )
      .addSubcommand((s) =>
        s
          .setName('verificacion')
          .setDescription('Cómo se aceptan likes y reposts (X no permite verlos sin API)')
          .addStringOption((o) =>
            o
              .setName('modo')
              .setDescription('Modo')
              .setRequired(true)
              .addChoices(
                { name: 'Declaración (rápido, se contrasta con el contador público)', value: 'declared' },
                { name: 'Captura obligatoria', value: 'screenshot' },
                { name: 'Revisión manual del staff', value: 'review' },
              ),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('calidad')
          .setDescription('Calidad mínima de los comentarios (0-100)')
          .addIntegerOption((o) => o.setName('minimo').setDescription('Recomendado: 35').setRequired(true).setMinValue(0).setMaxValue(100)),
      )
      .addSubcommand((s) =>
        s
          .setName('recordatorios')
          .setDescription('Recordatorios antes de que termine una tarea')
          .addBooleanOption((o) => o.setName('activar').setDescription('Activar o desactivar').setRequired(true))
          .addIntegerOption((o) => o.setName('minutos').setDescription('Minutos antes del final').setMinValue(1).setMaxValue(1440))
          .addStringOption((o) =>
            o
              .setName('modo')
              .setDescription('Dónde avisar')
              .addChoices({ name: 'En el canal', value: 'channel' }, { name: 'Por mensaje directo', value: 'dm' }, { name: 'Ambos', value: 'both' }),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('puntos')
          .setDescription('Puntos por acción')
          .addIntegerOption((o) => o.setName('like').setDescription('Like').setMinValue(0).setMaxValue(1000))
          .addIntegerOption((o) => o.setName('repost').setDescription('Repost').setMinValue(0).setMaxValue(1000))
          .addIntegerOption((o) => o.setName('comentario').setDescription('Comentario').setMinValue(0).setMaxValue(1000))
          .addIntegerOption((o) => o.setName('cita').setDescription('Cita').setMinValue(0).setMaxValue(1000))
          .addIntegerOption((o) => o.setName('bonus').setDescription('Bonus por completar todo').setMinValue(0).setMaxValue(1000)),
      )
      .addSubcommand((s) =>
        s
          .setName('duracion')
          .setDescription('Duración por defecto de las tareas')
          .addStringOption((o) => o.setName('tiempo').setDescription('Ej.: 45m, 2h, 1d').setRequired(true).setMaxLength(20)),
      ),
  );

  return [vincular, desvincular, perfil, tareas, verificar, prueba, ranking, ayuda, panel, tarea, miembro, config];
}

function commandsJSON() {
  return build().map((c) => c.toJSON());
}

module.exports = { commandsJSON };
