CREATE TABLE `project_element_categories` (
	`project_id` text NOT NULL,
	`category_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `category_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `element_categories`(`id`) ON UPDATE no action ON DELETE cascade
);
