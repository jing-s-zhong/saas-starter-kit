const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jackson = require('@boxyhq/saml-jackson');
const readline = require('readline');

const product = process.env.JACKSON_PRODUCT_ID || 'boxyhq';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const jacksonOpts = {
  externalUrl: `${process.env.APP_URL}`,
  samlPath: '/api/oauth/saml',
  oidcPath: '/api/oauth/oidc',
  samlAudience: 'https://saml.boxyhq.com',
  db: {
    engine: 'sql',
    type: 'postgres',
    url: `${process.env.DATABASE_URL}`,
  },
  idpDiscoveryPath: '/auth/sso/idp-select',
  idpEnabled: true,
  openid: {},
};

const jacksonOptions = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.JACKSON_API_KEY}`,
  },
};

const useHostedJackson = process.env.JACKSON_URL ? true : false;

let jacksonInstance;

let dryRun = false;

init();

async function init() {
  if (process.argv.length < 3) {
    console.log(
      `Usage: 
        node delete-team.js [options] <teamId> [teamId]
        npm run delete-team -- [options] <teamId> [teamId]
        
      Options:
        --dry-run: Run the script without deleting anything`
    );
    console.log(
      `Example: 
        node delete-team.js 01850e43-d1e0-4b92-abe5-271b159ff99b
        npm run delete-team -- 01850e43-d1e0-4b92-abe5-271b159ff99b`
    );
    process.exit(1);
  } else {
    if (!useHostedJackson) {
      console.log('Using embedded Jackson');
      jacksonInstance = await jackson.default(jacksonOpts);
    }
    let i = 2;
    if (process.argv.map((a) => a.toLowerCase()).includes('--dry-run')) {
      console.log('Running in dry-run mode');
      dryRun = true;
      i++;
    }
    for (i; i < process.argv.length; i++) {
      const teamId = process.argv[i];
      try {
        await displayDeletionArtifacts(teamId);

        if (!dryRun) {
          const confirmed = await askForConfirmation(teamId);
          if (confirmed) {
            await handleTeamDeletion(teamId);
          }
        }
      } catch (error) {
        console.log('Error deleting team:', error?.message);
      }
    }
    await prisma.$disconnect();
    console.log('\nDisconnected from database');
    process.exit(0);
  }
}

async function displayDeletionArtifacts(teamId) {
  // Team Details
  const team = await getTeamById(teamId);
  if (!team) {
    throw new Error(`Team not found: ${teamId}`);
  }
  console.log('\nTeam Details:');
  printTable([team], ['id', 'name', 'billingId']);

  // SSO Connections
  const ssoConnections = await getSSOConnections({
    tenant: team.id,
    product,
  });
  if (ssoConnections.length > 0) {
    console.log('\nSSO Connections:');
    printTable(ssoConnections, ['product', 'tenant', 'clientID']);
  } else {
    console.log('\nNo SSO connections found');
  }

  // DSync Connections
  const dsyncConnections = await getConnections(team.id);
  if (dsyncConnections.length > 0) {
    console.log('\nDSync Connections:');
    printTable(dsyncConnections, ['id', 'type', 'name', 'product']);
  } else {
    console.log('\nNo DSync connections found');
  }

  if (team?.billingId) {
    // Active Subscriptions
    const activeSubscriptions = await getActiveSubscriptions(team);
    if (activeSubscriptions.length > 0) {
      console.log('\nActive Subscriptions:');
      printTable(activeSubscriptions, ['id', 'startDate', 'endDate']);
    } else {
      console.log('\nNo active subscriptions found');
    }

    // All subscriptions
    const subscriptions = await prisma.subscription.findMany({
      where: {
        customerId: team?.billingId,
      },
    });
    if (subscriptions.length > 0) {
      console.log('\nAll Subscriptions:');
      printTable(subscriptions, ['id', 'startDate', 'endDate', 'active']);
    } else {
      console.log('\nNo subscriptions found');
    }
  } else {
    console.log('\nNo billingId found');
  }

  // Team Members
  const teamMembers = await prisma.user.findMany({
    where: {
      teamMembers: {
        some: {
          teamId: team.id,
        },
      },
    },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });
  for (let i = 0; i < teamMembers.length; i++) {
    const user = teamMembers[i];
    const userTeams = await prisma.teamMember.findMany({
      where: {
        userId: user.id,
      },
    });
    teamMembers[i].teams = userTeams.length;
    teamMembers[i].action = userTeams.length > 1 ? 'Remove' : 'Delete';
  }
  console.log('\nTeam Members:');
  printTable(teamMembers, ['id', 'email', 'name', 'teams', 'action']);

  const apiKeys = await prisma.apiKey.findMany({ where: { teamId: team.id } });
  if (apiKeys.length > 0) {
    console.log('\nAPI Keys:');
    printTable(apiKeys, ['id', 'name']);
  } else {
    console.log('\nNo API keys found');
  }

  const invitations = await prisma.invitation.findMany({
    where: { teamId: team.id },
  });
  if (invitations.length > 0) {
    console.log('\nInvitations:');
    printTable(invitations, ['id', 'email', 'role']);
  } else {
    console.log('\nNo invitations found');
  }
}

async function handleTeamDeletion(teamId) {
  console.log(`\nChecking team: ${teamId}`);
  let team = await getTeamById(teamId);
  if (!team) {
    console.log(`Team not found: ${teamId}`);
    return;
  } else {
    console.log('Team found:', team.name);
    if (team?.billingId) {
      console.log('\nChecking active team subscriptions');
      const activeSubscriptions = await getActiveSubscriptions(team);
      if (activeSubscriptions.length > 0) {
        console.log(
          `${activeSubscriptions.length} Active subscriptions found. Please cancel them before deleting the team.`
        );
        printTable(activeSubscriptions, ['id', 'startDate', 'endDate']);
        return;
      } else {
        console.log('No active subscriptions found');
      }
    }
    await removeDSyncConnections(team);
    await removeSSOConnections(team);
    await removeTeamSubscriptions(team);
    await removeTeamMembers(team);
    await removeTeam(team);
  }
}

async function getTeamById(teamId) {
  return await prisma.team.findUnique({
    where: {
      id: teamId,
    },
  });
}

async function removeTeam(team) {
  console.log('\nDeleting team:', team.id);
  await prisma.team.delete({
    where: {
      id: team.id,
    },
  });
  console.log('Team deleted:', team.name);
}

async function removeSSOConnections(team) {
  const params = {
    tenant: team.id,
    product,
  };
  if (useHostedJackson) {
    const ssoUrl = `${process.env.JACKSON_URL}/api/v1/sso`;
    const query = new URLSearchParams(params);

    const response = await fetch(`${ssoUrl}?${query}`, {
      ...jacksonOptions,
      method: 'DELETE',
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error.message);
    }
  } else {
    const { apiController } = jacksonInstance;

    await apiController.deleteConnections(params);
  }
}

async function getSSOConnections(params) {
  if (useHostedJackson) {
    const ssoUrl = `${process.env.JACKSON_URL}/api/v1/sso`;
    const query = new URLSearchParams(params);

    const response = await fetch(`${ssoUrl}?${query}`, {
      ...jacksonOptions,
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error.message);
    }
    const data = await response.json();
    return data;
  } else {
    const { apiController } = jacksonInstance;

    return await apiController.getConnections(params);
  }
}

async function removeDSyncConnections(team) {
  console.log(`\nChecking team DSync connections`);
  const connections = await getConnections(team.id);
  console.log(`Found ${connections.length} DSync connections`);
  for (const connection of connections) {
    console.log('\nDeleting DSync connection:', connection.id);
    await deleteConnection(connection.id);
    console.log('DSync connection deleted:', connection.id);
  }
  console.log(`\nDone removing team DSync connections`);
}

async function removeTeamSubscriptions(team) {
  console.log('\nDeleting team subscriptions');
  if (team?.billingId) {
    await prisma.subscription.deleteMany({
      where: {
        customerId: team?.billingId,
      },
    });
  }
  console.log('Team subscriptions deleted');
}

async function getActiveSubscriptions(team) {
  return await prisma.subscription.findMany({
    where: {
      customerId: team?.billingId,
      active: true,
      endDate: {
        gt: new Date(),
      },
    },
    select: {
      id: true,
      customerId: true,
      startDate: true,
      endDate: true,
      priceId: true,
    },
  });
}

async function removeTeamMembers(team) {
  console.log('\nChecking team members');

  const teamMembers = await prisma.user.findMany({
    where: {
      teamMembers: {
        some: {
          teamId: team.id,
        },
      },
    },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });
  console.log(`Found ${teamMembers.length} team members`);
  printTable(teamMembers);

  for (const user of teamMembers) {
    await checkAndRemoveUser(user, team);
  }
}

async function checkAndRemoveUser(user, team) {
  console.log('\nChecking user:', user.id);
  const userTeams = await prisma.teamMember.findMany({
    where: {
      userId: user.id,
    },
  });
  console.log(`User belongs to ${userTeams.length} teams`);
  if (userTeams.length === 1) {
    console.log('Deleting user:', user.email);
    await prisma.user.delete({
      where: {
        id: user.id,
      },
    });
    console.log('User deleted:', user.email);
  } else {
    console.log('Removing user from team:', team.name);
    await prisma.teamMember.deleteMany({
      where: {
        userId: user.id,
        teamId: team.id,
      },
    });
    console.log('User removed from team:', team.name);
  }
}

async function getConnections(tenant) {
  if (useHostedJackson) {
    const searchParams = new URLSearchParams({
      tenant: tenant,
      product,
    });

    const response = await fetch(
      `${process.env.JACKSON_URL}/api/v1/dsync?${searchParams}`,
      {
        ...jacksonOptions,
      }
    );

    const { data, error } = await response.json();

    if (!response.ok) {
      throw new Error(error.message);
    }

    return data;
  } else {
    const { directorySyncController } = jacksonInstance;

    const { data, error } =
      await directorySyncController.directories.getByTenantAndProduct(
        tenant,
        product
      );

    if (error) {
      throw new Error(error.message);
    }

    return data;
  }
}

async function deleteConnection(directoryId) {
  if (useHostedJackson) {
    const response = await fetch(
      `${process.env.JACKSON_URL}/api/v1/dsync/${directoryId}`,
      {
        ...jacksonOptions,
        method: 'DELETE',
      }
    );

    const { data, error } = await response.json();

    if (!response.ok) {
      throw new Error(error.message);
    }

    return { data };
  } else {
    const { directorySyncController } = jacksonInstance;

    const { data, error } =
      await directorySyncController.directories.delete(directoryId);

    if (error) {
      throw new Error(error.message);
    }

    return { data };
  }
}

async function askForConfirmation(teamId) {
  return new Promise((resolve) => {
    rl.question(
      `Are you sure you want to delete team ${teamId}? (yes/no): `,
      (answer) => {
        if (answer.toLowerCase() === 'yes') {
          resolve(true);
        } else {
          console.log('Deletion canceled.');
          resolve(false);
        }
        rl.close();
      }
    );
  });
}

function printTable(data, columns) {
  const final = {};
  data.forEach((ele, index) => {
    final[index + 1] = ele;
  });
  console.table(final, columns);
}

// handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});
