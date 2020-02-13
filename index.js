#!/bin/sh
":" //# https://fabri.ca/; exec /usr/bin/env node --noharmony "$0" "$@"

'use strict';

const findup = require('findup-sync'),
	http = require('http'),
	merge = require('lodash/merge'),
	path = require('path'),
	program = require('commander'),
	Promise = require('promise'),
	sh = require('shelljs'),
	// `shelljs.exec` doesn't handle color and animations yet
	// https://github.com/shelljs/shelljs/issues/86
	spawn = require('child_process').spawnSync,
	yaml = require('js-yaml');

const execGet = cmd => sh.exec(cmd, { silent: true }).stdout.trim();

// Fabrica Dev Kit version
const VERSION = execGet('npm list fabrica-dev-kit --depth=0 -g').replace(/^[^@]*@([^\s]*)\s.*$/, '$1'),
// maximum time (in milliseconds) to wait for wp container to be up and running
	WAIT_WP_CONTAINER_TIMEOUT = 360 * 1000,
	project = {
		isInstalled: false, // command executed inside an already setup project?	
	};

// output functions
const echo = (message, icon='🏭') => {
	console.log(`\x1b[7m[Fabrica]\x1b[27m ${icon}  ${message}`);
};
const warn = message => {
	console.error(`\x1b[1m\x1b[41m[Fabrica]\x1b[0m ⚠️  ${message}`);
}
const halt = message => {
	warn(message);
	process.exit(1)
};
const wait = (message, callback, delay) => {
	delay = delay || 500;
	return new Promise((resolve, reject) => {
		console.log();
		const spinner = ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'];
		let waitcounter = 0,
			handler,
			stopWaitInterval = response => {
				clearTimeout(handler);
				console.log();
				resolve(response);
			};
		handler = setInterval(() => {
			// move cursor to beginning of line
			process.stdout.clearLine();
			process.stdout.cursorTo(0);
			// write with no line change
			process.stdout.write(`\x1b[7m[Fabrica]\x1b[27m ${spinner[waitcounter % 12]}  ${message}`);
			callback(stopWaitInterval);
			waitcounter++;
			// send callback a closure to stop the interval timer
		}, delay);
	});
};

// check Fabrica dependencies
const checkDependencies = () => {
	const dependencies = ['docker-compose', 'composer'];
	for (let dependency of dependencies) {
		if (sh.exec(`hash ${dependency} 2>/dev/null`, {silent: true}).code != 0) {
			halt(`Could not find dependency '${dependency}'.`);
		}
	}
}
checkDependencies();

const getSetupPackageManager = (settings) => {
	let packageManager = '';

	if (settings.package_manager && sh.exec(`hash ${settings.package_manager} 2>/dev/null`, {silent: true}).code == 0) {
		return settings.package_manager;
	}

	const dependencies = ['npm', 'yarn'];
	for (let dependency of dependencies) {
		if (sh.exec(`hash ${dependency} 2>/dev/null`, {silent: true}).code == 0) {
			packageManager = dependency;
			break;
		}
	}
	if (packageManager == '') {
		halt('Could not find any Node package manager (\'npm\' or \'yarn\').');
	}
	return packageManager;
}

// load all settings files
const loadSetupSettings = (reinstall) => {
	echo('Reading settings...');
	let settings = {
		reinstall: reinstall || false,
	};
	// auxiliar method to get settings from the files
	let mergeSettings = (filename) => {
		if (!sh.test('-f', filename)) { return; }
		let newSettings;
		try {
			newSettings = yaml.safeLoad(sh.cat(filename));
		} catch (ex) {
			halt(`Failed to open settings file: ${filename}.\nException: ${ex}`);
		}
		merge(settings, newSettings);
	}

	// get user's UID/GID to match on container's user
	settings.user = {
		uid: execGet('id -u $(whoami)'),
		gid: execGet('id -g $(whoami)'),
	}

	// load default, user and project/site settings, in that order
	mergeSettings(`${process.env.HOME}/.fabrica/settings.yml`);
	const setupSettingsFilename = './setup.yml',
		setupSettingsBakFilename = './config/setup.yml';
	if (!sh.test('-f', setupSettingsFilename)) {
		if (settings.reinstall && !sh.test('-f', setupSettingsFilename)) {
			sh.mv(setupSettingsBakFilename, setupSettingsFilename);
		} else if (settings.reinstall) {
			halt('Could not find \'setup.yml\' or \'config/setup.yml\'. Please use the \'fdk init <slug>\' command to create a new project folder and \'setup.yml\'.');
		} else {
			halt('Could not find \'setup.yml\'. Please use the \'fdk init <slug>\' command to create a new project folder and \'setup.yml\'. If the current project has been set up previously, you can run \'fdk setup --reinstall\' and \'config/setup.yml\' will be used to bring the Docker containers back up and reconfigure them.');
		}
	}
	mergeSettings(setupSettingsFilename);

	// check if there's already a Docker container for the project slug
	if (execGet(`docker ps -aqf name=${settings.slug}_wp`)) {
		if (settings.reinstall) {
			echo(`Docker container with '${settings.slug}_wp' found but ignored because '--reinstall' flag is set`);
		} else {
			halt(`There's already a Docker container called '${settings.slug}_wp'. If this container belongs to another project remove all containers for that project or rename this one before running setup. Otherwise run \'fdk setup --reinstall\' to re-use already existing Docker containers for this project.`);
		}
	}

 	// move/backup 'setup.yml'
	sh.mkdir('-p', 'config');
	sh.mv(setupSettingsFilename, setupSettingsBakFilename);

	return settings;
};

// create and copy project folders
const createFolders = settings => {
	// set up folder content
	if (!sh.test('-f', 'package.json')) {
		// new project: copy starter development folder
		sh.cp('-r', [`${__dirname}/dev/*`, `${__dirname}/dev/.*`], '.');
		// npm publish doesn't include .gitignore: https://github.com/npm/npm/issues/3763
		sh.mv('gitignore', '.gitignore');
		// create 'www' folder (to ensure its owner is the user running the script)
		sh.mkdir('-p', 'www');

		// set configuration data in source and Wordmove files
		let templateFilenames = [
			'package.json',
			'docker-compose.yml',
			'provision/web/wordpress-fpm.conf'
		];
		for (let destFilename of templateFilenames) {
			// load template file and generate final version
			let srcFilename = `${process.cwd()}/${destFilename}.js`;
			if (sh.test('-f', srcFilename)) {
				let generatedFile = require(srcFilename)(settings);
				sh.ShellString(generatedFile).to(destFilename);
				sh.rm(srcFilename);
			} else {
				halt(`Could not find ${srcFilename} template.`);
			}
		}
	} else {
		// working on an existing project
		let projectSettings = JSON.parse(sh.cat('package.json'));
		echo('Existing project \'package.json\' found. Overriding the following settings in \'setup.yml\' with those in this file  (old \'setup.yml\' value → new value):');
		let keys = {name: 'slug', description: 'title'};
		const simpleDiff = (value1, value2) => {
			if (value1 == value2) {
				return `${JSON.stringify(value1)} (unchanged)`;
			}
			return `${JSON.stringify(value1)} → ${JSON.stringify(value2)}`;
		}
		for (let projectKey of Object.keys(keys)) {
			let settingKey = keys[projectKey],
				diffMessage = ` ◦ ${settingKey}${settingKey != projectKey ? ` / ${projectKey}` : ''}: `;
			if (typeof projectSettings[projectKey] == 'object') {
				echo(`${diffMessage}`);
				Object.keys(projectSettings[projectKey]).forEach((key) =>
					echo(`   • ${key}: ${simpleDiff(settings[settingKey][key], projectSettings[projectKey][key])}`)
				);
			} else {
				echo(`${diffMessage} ${simpleDiff(settings[settingKey], projectSettings[projectKey])}`);
			}
			settings[settingKey] = projectSettings[projectKey];
		}
	}
};

// install build dependencies
const installDependencies = (packageManager) => {
	echo('Installing build dependencies...');
	spawn(`${packageManager}`, ['install'], { stdio: 'inherit' });
};

// install and configure WordPress in the Docker container
let installWordPress = (webPort, settings) => {
	echo('Installing WordPress...');
	let dockerCmd = 'docker-compose exec -u www-data wp',
		wp = command => {
			if (sh.exec(`${dockerCmd} wp ${command}`).code != 0) {
				halt(`Failed to execute: '${dockerCmd} wp ${command}'`);
			}
		};

	// use stdout stream to filter out known WP CLI warning
	let install = sh.exec([`${dockerCmd} wp core ${settings.wp.multisite ? 'multisite-' : ''}install`,
		`--url=${settings.wp.multisite ? `${settings.slug}.local --subdomains` : `localhost:${webPort}`}`,
		`--title="${settings.title}"`,
		`--admin_user=${settings.wp.admin.user}`,
		`--admin_password=${settings.wp.admin.pass}`,
		`--admin_email="${settings.wp.admin.email}"`].join(' '),
		{silent: true, async: true});
	install.stdout.on('data', data => {
		let output = data.toString('utf8');
		// filter out WP CLI warning
		process.stdout.write(output.replace('sh: 1: -t: not found', ''));
	}).on('error', error => {
		halt(`Failed to install WordPress:\n${error}`);
	}).on('end', () => {
		if (install.exitCode && install.exitCode) {
			halt(`Failed to install WordPress`);
		}

		// WordPress installed succesfully: proceed with configuration
		wp(`rewrite structure "${settings.wp.rewrite_structure}"`);
		if (settings.wp.lang == 'ja') {
			// activate multibyte patch for Japanese language
			wp('plugin activate wp-multibyte-patch');
		}
		
		// install and activate WordPress plugins
		for (let plugin of (settings.wp.plugins || [])) {
			wp(`plugin install "${plugin}" --activate`);
		}
		if (settings.wp.acf_pro_key) {
			let execCode = sh.exec([`${dockerCmd} bash -c 'curl "http://connect.advancedcustomfields.com/index.php?p=pro&a=download&k=${settings.wp.acf_pro_key}" > /tmp/acf-pro.zip`,
				`&& wp plugin install /tmp/acf-pro.zip --activate`,
				`&& rm /tmp/acf-pro.zip'`].join(' ')).code;
		}
		// remove default WordPress plugins and themes
		if (settings.wp.skip_default_plugins) {
			wp(`plugin delete "hello" "akismet"`);
		}
		if (settings.wp.skip_default_themes) {
			wp(`theme delete "twentyseventeen" "twentysixteen" "twentyfifteen"`);
		}
		// WordPress options
		for (let option of Object.keys(settings.wp.options || {})) {
			let value = settings.wp.options[option];
			wp(`option update ${option} "${value}"`);
		}
		// Default post
		if (!settings.reinstall) {
			wp(`post update 1 --post_name='welcome-to-fabrica-dev-kit' --post_title='Welcome to Fabrica Dev Kit' --post_content='For more information about developing with Fabrica Dev Kit, <a href="https://github.com/fabrica-wp/fabrica-dev-kit">see the documentation</a>.'`);
		}

		// the site will be ready to run and develop locally
		echo('Setup complete. To develop locally, setup the resources to import automatically in \'resources/index.json\' and run \'fdk start\'.');
	});
}

// add custom domain to /etc/hosts for multisite setups
const setupMultisiteCustomDomain = settings => {
	if (!settings.wp.multisite) { return; }

	try {
		if (execGet(`cat /etc/hosts | grep "${settings.slug}.local"`)) {
			echo(`'${settings.slug}.local' already in in /etc/hosts.`);
		} else {
			echo(`sudo access required to add '${settings.slug}.local' to /etc/hosts`, '🔐');
			execGet(`echo "127.0.0.1 ${settings.slug}.local" | sudo tee -a /etc/hosts`);
		}
	} catch (ex) {
		warn(`Error setting up custom local domain '${settings.slug}.local' in /etc/hosts.`);
	}
}

// start Docker containers and wait for them to be up to start installing and configuring WP
const startContainersAndInstall = settings => {
	echo('Bringing Docker containers up...');
	if (sh.exec('docker-compose up -d').code != 0) {
		halt('Docker containers provision failed.');
	}

	// wait until `wp` container is up to install WordPress
	let startTime = Date.now(), getting = false, webPort;
	wait(`Waiting for '${settings['slug']}_wp' container...`, stopWaitInterval => {
		// get port dynamically assigned by Docker to expose web container's port 80
		webPort = webPort ||
			execGet('docker-compose port web 80').replace(/^.*:(\d+)$/, '$1');
		if (webPort && !getting) {
			// check if WordPress is already available at the expected URL
			getting = true;
			http.get(`http://localhost:${webPort}/wp-admin/install.php`, response => {
				getting = false;
				if (response.statusCode == '200') {
					// container is up
					stopWaitInterval(true);
				}
			}).on('error', error => {
				// ignore errors (container still not up)
				getting = false;
			});
		}
		if (Date.now() - startTime > WAIT_WP_CONTAINER_TIMEOUT) {
			// timeout
			stopWaitInterval(false);
		}
	}).then(success => {
		// wait is over: containers are up or timeout has expired
		if (!success) {
			halt(`More than ${WAIT_WP_CONTAINER_TIMEOUT / 1000} seconds elapsed while waiting for WordPress container to start.`);
		}
		echo(`Web server running at port ${webPort}`);

		// set WordPress folder owner
		sh.exec('docker-compose exec wp sh -c "chown -R www-data:www-data ."');

		setupMultisiteCustomDomain(settings);
		installWordPress(webPort, settings);
	}).catch(error => {
		halt(`Error installing or configuring WordPress:\n${error}`);
	});
}

// Commands

const init = (slug, options) => {
	if (options.createDir) {
		if (!slug) {
			halt(`If the flag to create project folder is set, a <slug> must be provided.`);
		}
		if (sh.test('-e', slug)) {
			halt(`There's already a file or folder called '${slug}'.`);
		}
		echo(`Creating '${slug}' folder...`);

		sh.mkdir(slug);
		sh.cd(slug);
	}

	if (!slug) {
		slug = path.basename(path.resolve()).toLowerCase()
			.replace(/[^\w\-]+/g, '')       // Remove all non-word chars
			.replace(/\-*\s+\-*/g, '-')     // Replace spaces with -
			.replace(/^\-+|\-+$/g, '')      // Trim
		echo(`No <slug> parameter was provided, using '${slug}' as project slug. You can edit this setting in 'setup.yml'.`);
	}

	if (sh.test('-e', 'setup.yml')) {
		halt(`'setup.yml' already exists. File was not changed. Edit settings in this file with a text editor to setup the project.`);
	}
	echo(`Creating the 'setup.yml' file...`);
	let data = Object.assign({ slug: slug }, options),
		generatedFile = require(`${__dirname}/setup.yml.js`)(data);
	sh.ShellString(generatedFile).to(`./setup.yml`);
	echo(`Project initial 'setup.yml' file created. Edit settings in this file and run 'fdk setup' to setup the project.`);
};

const setup = options => {
	const settings = loadSetupSettings(options.reinstall),
		packageManager = getSetupPackageManager(settings);
	createFolders(settings);
	installDependencies(packageManager);
	startContainersAndInstall(settings);
};

// -- Project-specific commands ---

// Get current site and port for WordPress to check if it matches the current Docker-assigned Web container port (in a singlesite project). Output current project access URLs and ports
const urlConfig = () => {
	const dockerCmd = 'docker-compose exec -u www-data -T wp',
		dbPort = execGet('docker-compose port db 3306').replace(/^.*:(\d+)$/g, '$1'),
		siteURL = execGet(dockerCmd + ' wp option get siteurl');

	if (siteURL.indexOf('localhost:') >= 0 && siteURL.indexOf('127.0.0.1:') >= 0) {
		// not in a multisite/custom domain project: check if automatic port set by Docker needs to be updated in the DB
		const webPort = execGet('docker-compose port web 80').replace(/^.*:(\d+)$/g, '$1'),
			wpPort = siteURL.replace(/^.*:(\d+)$/g, '$1');
		if (wpPort != webPort) {
			// port needs to be updated
			console.log('Updating WordPress port from ' + wpPort + ' to ' + webPort + '...');
			sh.exec(dockerCmd + ' wp search-replace --quiet "localhost:' + wpPort + '" "localhost:' + webPort + '"');
			sh.exec(dockerCmd + ' bash -c \'wp option update home "http://localhost:' + webPort + '" && wp option update siteurl "http://localhost:' + webPort + '"\'');
		}
	}

	// output site URLs and ports
	let outputSeparator = ' \x1b[36m' + '-'.repeat(siteURL.length + 21) + '\x1b[0m';
	console.log('\x1b[1m' + project.title + ' (' + project.slug + ') access URLs:\x1b[22m');
	console.log(outputSeparator);
	console.log(' 🌍  WordPress: \x1b[35m' + siteURL + '/\x1b[0m');
	console.log(' 🔧  Admin: \x1b[35m' + siteURL + '/wp-admin/\x1b[0m');
	console.log(' 🗃  Database: \x1b[35mlocalhost:' + dbPort + '\x1b[0m');
	console.log(outputSeparator);
};

// check if FDK is being executed inside a project that's already been setup and load its settings
const loadProjectSettings = () => {
	let rootDir = findup('config/setup.yml', { cwd: process.cwd() });
	if (!rootDir) { return; }

	rootDir = path.normalize(path.join(path.dirname(rootDir), '..'));
	if (!sh.test('-f', `${rootDir}/docker-compose.yml`)
		|| !sh.test('-f', `${rootDir}/package.json`)) { return; }

	if (rootDir != process.cwd()) {
		// change to project root folder and add `package.json` scripts to commands
		sh.cd(rootDir);
		echo(`Working directory changed to ${rootDir}`);
	}

	project.isInstalled = true;
	project.rootDir = rootDir;
	project.package = require(`${rootDir}/package.json`);
	project.slug = project.package.name;
	project.title = project.package.description;
};

// add commands for project's root `package.json` if current path is part of a project
const addScriptCommands = () => {
	if (!project.isInstalled) { return; }

	const packageManager = sh.test('-f', `${project.rootDir}/yarn.json`) ? 'yarn' : 'npm';

	const scripts = project.package.scripts;
	for (let command of Object.keys(scripts)) {
		let script = scripts[command];
		let scriptsInfo = (project.package.fabrica_dev_kit || {}).scripts_info || {};
		program.command(command)
			.description(`'package.json' script: ${scriptsInfo[command] || '`' + (script.length > 80 ? script.substr(0, 80) + '…' : script) + '`'}`)
			.action(() => {
				spawn(packageManager, ['run', ...process.argv.splice(2)], { stdio: 'inherit' });
			});
	}
};

// add project-specific commands (ie., not available on folders outside a project that hasn't been set up yet)
const addProjectCommands = () => {
	if (!project.isInstalled) { return; }

	program.command('url-config')
		.description('Update URLs in DB to match changes to WP container port set automatically by Docker (except for multisite projects, where a custom local host/domain is used). Output current access URLs and ports')
		.action(urlConfig);
	addScriptCommands();
};


// fabrica-wp/fabrica-dev-kit#34 / docker/compose#5696 fix
sh.env['COMPOSE_INTERACTIVE_NO_CLI'] = 1;
// set command line options
program.version(VERSION)
	.usage('[options] <command>')
	.description(`Run 'init [slug]' to start a new project.\n\n    fdk <command> -h\tquick help on <command>`);
// `init` command
program.command('init [slug]')
	.description('Start a new project folder called <slug> containing the \'setup.yml\' configuration file. <slug> must be unique and no other Docker Compose project should share this name. All optional arguments will be set in the \'setup.yml\' file and can be modified there.')
	.option('-d, --create-dir', 'create folder for project with <slug> name (current folder will be used for new project if not passed)')
	.option('-t, --title <title>', 'project title')
	.option('--wp_admin_user <username>', 'WordPress admin username')
	.option('--wp_admin_pass <password>', 'WordPress admin password')
	.option('--wp_admin_email <email>', 'WordPress admin email')
	.option('-m, --multisite', 'support multisite network')
	.action(init);
// `setup` command
program.command('setup')
	.description('Setup project based on setting on \'setup.yml\' file')
	.option('--reinstall', 'Reuse settings for previously setup project and ignore if Docker containers are already in use for project <slug>. \'config/setup.yml\' will be used for configuration if \'setup.yml\' is not available.')
	.action(setup);
// load settings if executed in a project that's already been set up
loadProjectSettings();
if (project.isInstalled) {
	// add project-specific scripts (including those in `package.json`)
	addProjectCommands();
}
// default
program.command('*', null, {noHelp: true})
	.action(() => { program.help(); });
// finalize `commander` config
program.parse(process.argv);
// show help if no arguments are passed
if (program.args.length === 0) { program.help(); }
